// SageFin Desktop's key helper for Windows: the two keys this computer holds for a private SageFin
// household, made in its TPM and used only after Windows Hello.
//
// The app (main/key-store.mjs) runs it once per request and talks to it in JSON lines on stdin and
// stdout, exactly as it talks to the Mac's helper (native/macos/SageFinKeys.swift). It answers
// public keys, one raw P-256 agreement and one signature, and never a private key: both keys are
// made by the TPM through the Microsoft Platform Crypto Provider, cannot be exported, and open on
// this computer's TPM and nowhere else.
//
//   sagefin-keys <service>                      then {"op":"public-keys"}, {"op":"create"} or
//                                                 {"op":"probe"}
//   sagefin-keys <service> --approve <sentence>  then {"op":"presence"}, {"op":"agree","peer":…},
//                                                 {"op":"sign","bytes":…}: at most one agreement,
//                                                 then one signature, which ends the approval
//   sagefin-keys --self-test                     checks the TPM side with throwaway keys, and
//                                                 shows no prompt (see SelfTest.cs)
//
// How Windows Hello gates the keys. The TPM will not use either key without its usage password,
// and neither password is stored anywhere. Each is derived (HKDF-SHA-256) from a signature that
// a Windows Hello key (KeyCredentialManager, itself in the TPM) makes over a fixed challenge, and
// Windows asks for the face, fingerprint or PIN before every such signature. So every use of the
// household's keys starts with Windows Hello's own prompt, and a program that cannot get past that
// prompt cannot make the TPM use them: the TPM checks the password, not this program.
//
// What that does not protect against, said plainly in the readme: the password exists in this
// program's memory for the moment it is used, so malware running as the member that read it then
// could use the keys afterwards without Windows Hello; and it relies on Windows Hello's RSA
// signatures being deterministic (PKCS#1 v1.5 is), which Microsoft does not promise. If a
// signature ever changes, a check value kept beside the keys says so before the TPM is asked, so
// a wrong password never counts against the TPM's lockout, and the member adds the computer again.
//
// One approval is one Windows Hello signature, then one agreement and one signature, then exit.
// Windows's prompt cannot carry the sentence the app passes: Windows Hello shows its own words,
// and the app's unlock window, in front of it, says what the approval is for.
//
// Refused in a Remote Desktop session, where Windows Hello's local prompt is not what answers.

using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Windows.Security.Credentials;
using Windows.Security.Cryptography;
using Windows.Security.Cryptography.Core;

namespace SageFinKeys;

/// <summary>A failure the app is told by its code, as the Mac's helper does.</summary>
sealed class Failure(string code) : Exception(code)
{
    public string Code { get; } = code;
}

static partial class Program
{
    static async Task<int> Main(string[] args)
    {
        try
        {
            if (args is ["--self-test"]) return SelfTest.Run();
            if (args.Length < 1 || !ServicePattern().IsMatch(args[0])) throw new Failure("usage");
            var service = args[0];
            if (args.Length == 1) return await OneRequest(service);
            if (args.Length == 3 && args[1] == "--approve" && args[2].Length > 0) return await Approve(service);
            throw new Failure("usage");
        }
        catch (Failure f)
        {
            Answer(w => w.WriteString("error", f.Code));
            return 1;
        }
        catch
        {
            Answer(w => w.WriteString("error", "failed"));
            return 1;
        }
    }

    /// <summary>A site's short name from the app (lib/site.mjs): <c>prod</c>, <c>test</c>, <c>local</c>.</summary>
    [GeneratedRegex("^[a-z0-9-]{1,32}$")]
    private static partial Regex ServicePattern();

    // ── Without --approve: the public keys, or new keys ───────────────────────────────────────

    static async Task<int> OneRequest(string service)
    {
        var step = ReadStep() ?? throw new Failure("usage");
        switch (Op(step))
        {
            case "public-keys":
                var keys = await PublicKeys(service);
                Answer(w => { if (keys is { } k) WriteKeys(w, k); });
                return 0;
            case "create":
                var made = await Create(service);
                Answer(w => WriteKeys(w, made));
                return 0;
            case "probe":
                var tpm = Tpm.Available();
                var hello = await KeyCredentialManager.IsSupportedAsync();
                Answer(w =>
                {
                    w.WriteBoolean("tpm", tpm);
                    w.WriteBoolean("windowsHello", hello);
                    w.WriteBoolean("remoteSession", RemoteSession());
                });
                return 0;
            // Only for the helper's own checks (hello-check.mjs): the app never deletes a key.
            case "delete" when service.StartsWith("selftest", StringComparison.Ordinal):
                await Delete(service);
                Answer(w => w.WriteBoolean("deleted", true));
                return 0;
            default:
                throw new Failure("usage");
        }
    }

    /// <summary>
    /// Both public keys, or none when this computer holds none. Keys whose Windows Hello key is
    /// gone (Windows Hello was reset or removed) can never open again, so they count as none and
    /// the member adds the computer again. Nothing here prompts.
    /// </summary>
    static async Task<(byte[] Agreement, byte[] Signing)?> PublicKeys(string service)
    {
        if (!Tpm.Available()) return null;
        var agreement = Tpm.PublicKeyOf(KeyName(service, Role.Agreement));
        var signing = Tpm.PublicKeyOf(KeyName(service, Role.Signing));
        if (agreement is null || signing is null) return null;
        if (!await KeyCredentialManager.IsSupportedAsync()) return null;
        var opened = await KeyCredentialManager.OpenAsync(HelloName(service));
        if (opened.Status == KeyCredentialStatus.NotFound) return null;
        if (opened.Status != KeyCredentialStatus.Success) throw new Failure("keys-unreadable");
        if (!File.Exists(CheckPath(service))) throw new Failure("keys-unreadable");
        return (agreement, signing);
    }

    /// <summary>
    /// A new Windows Hello key, then the two TPM keys with passwords derived from its signature.
    /// One Windows Hello prompt: the one that makes the key. Its approval also covers the first
    /// signature straight after, which is what sets the passwords; that is creation, not a use.
    /// Every later use is a new process and a new prompt.
    /// </summary>
    static async Task<(byte[] Agreement, byte[] Signing)> Create(string service)
    {
        if (RemoteSession()) throw new Failure("remote-session");
        if (!Tpm.Available()) throw new Failure("no-tpm");
        if (!await KeyCredentialManager.IsSupportedAsync()) throw new Failure("no-windows-hello");

        // Old keys under these names are useless once the Windows Hello key is replaced.
        Tpm.Delete(KeyName(service, Role.Agreement));
        Tpm.Delete(KeyName(service, Role.Signing));
        TryDelete(CheckPath(service));

        var made = await Hello.Prompted(() =>
            KeyCredentialManager.RequestCreateAsync(HelloName(service), KeyCredentialCreationOption.ReplaceExisting).AsTask());
        if (made.Status == KeyCredentialStatus.UserCanceled) throw new Failure("cancelled");
        if (made.Status != KeyCredentialStatus.Success) throw new Failure("no-windows-hello");
        var credential = made.Credential;

        // A Windows Hello key Windows cannot attest is not in a TPM: software keys could be read by a
        // program running as the member, and with them the passwords, so this computer holds none.
        var attested = await credential.GetAttestationAsync();
        if (attested.Status is not (KeyCredentialAttestationStatus.Success or KeyCredentialAttestationStatus.TemporaryFailure))
        {
            await KeyCredentialManager.DeleteAsync(HelloName(service));
            throw new Failure("windows-hello-not-in-tpm");
        }

        var secret = await Hello.Sign(credential, Challenge(service), prompted: false);
        try
        {
            var agreement = Tpm.Create(KeyName(service, Role.Agreement), Tpm.Algorithm.EcdhP256, secret.UsageAuth(Role.Agreement));
            var signing = Tpm.Create(KeyName(service, Role.Signing), Tpm.Algorithm.EcdsaP256, secret.UsageAuth(Role.Signing));
            WriteCheck(service, secret.Check());
            return (agreement, signing);
        }
        catch
        {
            Tpm.Delete(KeyName(service, Role.Agreement));
            Tpm.Delete(KeyName(service, Role.Signing));
            TryDelete(CheckPath(service));
            throw;
        }
        finally
        {
            secret.Dispose();
        }
    }

    static async Task Delete(string service)
    {
        Tpm.Delete(KeyName(service, Role.Agreement));
        Tpm.Delete(KeyName(service, Role.Signing));
        TryDelete(CheckPath(service));
        var opened = await KeyCredentialManager.OpenAsync(HelloName(service));
        if (opened.Status == KeyCredentialStatus.Success) await KeyCredentialManager.DeleteAsync(HelloName(service));
    }

    // ── With --approve: one person, one agreement, one signature ─────────────────────────────

    static async Task<int> Approve(string service)
    {
        if (Op(ReadStep()) != "presence") throw new Failure("usage");
        if (RemoteSession()) throw new Failure("remote-session");
        if (await PublicKeys(service) is null) throw new Failure("no-keys");

        var opened = await KeyCredentialManager.OpenAsync(HelloName(service));
        if (opened.Status != KeyCredentialStatus.Success) throw new Failure("no-keys");

        // Windows Hello's prompt. Nothing below happens until the person answers it.
        using var secret = await Hello.Sign(opened.Credential, Challenge(service), prompted: true);
        if (!CryptographicOperations.FixedTimeEquals(secret.Check(), ReadCheck(service)))
            throw new Failure("keys-changed");
        Answer(w => w.WriteBoolean("presence", true));

        // Thirty seconds, then the process ends whatever is left, and the passwords with it.
        _ = Task.Delay(TimeSpan.FromSeconds(30)).ContinueWith(_ => Environment.Exit(0), TaskScheduler.Default);

        bool agreed = false, signed = false;
        while (ReadStep() is { } step)
        {
            switch (Op(step))
            {
                case "agree" when !agreed:
                    agreed = true;
                    var peer = Base64(step, "peer") ?? throw new Failure("no-keys");
                    var shared = Tpm.Agree(KeyName(service, Role.Agreement), secret.UsageAuth(Role.Agreement), peer);
                    Answer(w => w.WriteBase64String("agreement", shared));
                    CryptographicOperations.ZeroMemory(shared);
                    break;
                case "sign" when !signed:
                    signed = true;
                    var bytes = Base64(step, "bytes") ?? throw new Failure("no-keys");
                    var signature = Tpm.Sign(KeyName(service, Role.Signing), secret.UsageAuth(Role.Signing), bytes);
                    Answer(w => w.WriteBase64String("signature", signature));
                    break;
                default:
                    throw new Failure("once");
            }
            // The signature is the last use of an approval, with or without an agreement before it.
            if (signed) break;
        }
        return 0;
    }

    // ── Names, the challenge and the check value ──────────────────────────────────────────────

    internal enum Role { Agreement, Signing }

    internal static string KeyName(string service, Role role) =>
        $"SageFin Desktop {service} {(role == Role.Agreement ? "agreement" : "signing")}";

    internal static string HelloName(string service) => $"SageFin Desktop {service}";

    /// <summary>What Windows Hello signs: fixed per site, so the same key gives the same signature.</summary>
    internal static byte[] Challenge(string service) =>
        Encoding.UTF8.GetBytes($"SageFin Desktop key passwords, version 1, {service}");

    /// <summary>
    /// Where the check value is: beside nothing else, in this user's local (not roaming) app data,
    /// because the keys it checks are in this computer's TPM. It is not a secret: HKDF's outputs for
    /// different labels say nothing about each other, so it does not tell anyone the passwords.
    /// </summary>
    internal static string CheckPath(string service) =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SageFin Desktop Keys", $"{service}.check");

    static void WriteCheck(string service, byte[] check)
    {
        var path = CheckPath(service);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, Convert.ToBase64String(check));
    }

    static byte[] ReadCheck(string service)
    {
        try { return Convert.FromBase64String(File.ReadAllText(CheckPath(service)).Trim()); }
        catch { throw new Failure("keys-unreadable"); }
    }

    static void TryDelete(string path)
    {
        try { File.Delete(path); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }

    // ── JSON lines ────────────────────────────────────────────────────────────────────────────

    static readonly Stream Out = Console.OpenStandardOutput();

    internal static void Answer(Action<Utf8JsonWriter> fields)
    {
        using var buffer = new MemoryStream();
        using (var w = new Utf8JsonWriter(buffer))
        {
            w.WriteStartObject();
            fields(w);
            w.WriteEndObject();
        }
        buffer.WriteByte((byte)'\n');
        Out.Write(buffer.GetBuffer(), 0, (int)buffer.Length);
        Out.Flush();
    }

    static void WriteKeys(Utf8JsonWriter w, (byte[] Agreement, byte[] Signing) keys)
    {
        w.WriteBase64String("agreementPublicKey", keys.Agreement);
        w.WriteBase64String("signingPublicKey", keys.Signing);
    }

    static JsonElement? ReadStep()
    {
        var line = Console.In.ReadLine();
        if (string.IsNullOrWhiteSpace(line)) return null;
        try
        {
            using var doc = JsonDocument.Parse(line);
            return doc.RootElement.ValueKind == JsonValueKind.Object ? doc.RootElement.Clone() : null;
        }
        catch (JsonException) { return null; }
    }

    static string? Op(JsonElement? step) =>
        step is { } s && s.TryGetProperty("op", out var op) && op.ValueKind == JsonValueKind.String ? op.GetString() : null;

    static byte[]? Base64(JsonElement step, string name)
    {
        if (!step.TryGetProperty(name, out var v) || v.ValueKind != JsonValueKind.String) return null;
        try { return Convert.FromBase64String(v.GetString()!); } catch (FormatException) { return null; }
    }

    // ── Windows ───────────────────────────────────────────────────────────────────────────────

    internal static bool RemoteSession() => GetSystemMetrics(0x1000 /* SM_REMOTESESSION */) != 0;

    [LibraryImport("user32.dll")]
    private static partial int GetSystemMetrics(int index);
}

/// <summary>The two passwords and the check value, derived from one Windows Hello signature.</summary>
sealed class DerivedSecret(byte[] signature) : IDisposable
{
    static readonly byte[] Salt = Encoding.UTF8.GetBytes("sagefin-desktop/windows/key-passwords/v1");

    byte[] Derive(string label) => HKDF.DeriveKey(HashAlgorithmName.SHA256, signature, 32, Salt, Encoding.UTF8.GetBytes(label));

    /// <summary>A key's TPM usage password: 32 bytes, as PCP_USAGEAUTH takes it.</summary>
    public byte[] UsageAuth(Program.Role role) => Derive(role == Program.Role.Agreement ? "usage-auth/agreement" : "usage-auth/signing");

    /// <summary>Kept beside the keys, so a changed signature is found without asking the TPM.</summary>
    public byte[] Check() => Derive("check");

    public void Dispose() => CryptographicOperations.ZeroMemory(signature);
}

/// <summary>Windows Hello: KeyCredentialManager, whose keys are RSA-2048 and sign only.</summary>
static partial class Hello
{
    /// <summary>
    /// The signature over <paramref name="challenge"/>, checked against the key's public key.
    /// <paramref name="prompted"/> is whether Windows Hello is expected to ask: always, except the
    /// signature straight after the key was made, which that approval covers.
    /// </summary>
    public static async Task<DerivedSecret> Sign(KeyCredential credential, byte[] challenge, bool prompted)
    {
        var buffer = CryptographicBuffer.CreateFromByteArray(challenge);
        var signed = prompted
            ? await Prompted(() => credential.RequestSignAsync(buffer).AsTask())
            : await credential.RequestSignAsync(buffer);
        if (signed.Status == KeyCredentialStatus.UserCanceled) throw new Failure("cancelled");
        if (signed.Status != KeyCredentialStatus.Success) throw new Failure("windows-hello");
        CryptographicBuffer.CopyToByteArray(signed.Result, out byte[] signature);

        CryptographicBuffer.CopyToByteArray(credential.RetrievePublicKey(CryptographicPublicKeyBlobType.X509SubjectPublicKeyInfo), out byte[] spki);
        using var rsa = RSA.Create();
        rsa.ImportSubjectPublicKeyInfo(spki, out _);
        if (!rsa.VerifyData(challenge, signature, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1))
            throw new Failure("windows-hello");
        return new DerivedSecret(signature);
    }

    /// <summary>
    /// Runs a call that shows Windows Hello's prompt, and brings the prompt in front while it waits:
    /// started from a program with no window of its own, Windows can open it behind the app's.
    /// </summary>
    public static async Task<T> Prompted<T>(Func<Task<T>> call)
    {
        using var stop = new CancellationTokenSource();
        var front = Task.Run(async () =>
        {
            while (!stop.IsCancellationRequested)
            {
                var prompt = FindWindowW("Credential Dialog Xaml Host", null);
                if (prompt != 0) { SetForegroundWindow(prompt); return; }
                try { await Task.Delay(100, stop.Token); } catch (OperationCanceledException) { return; }
            }
        });
        try { return await call(); }
        finally { stop.Cancel(); await front; }
    }

    [LibraryImport("user32.dll", StringMarshalling = StringMarshalling.Utf16)]
    private static partial nint FindWindowW(string? className, string? windowName);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool SetForegroundWindow(nint window);
}
