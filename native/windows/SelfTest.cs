// `sagefin-keys --self-test`: the TPM side of the helper, checked on this computer with throwaway
// keys, showing no prompt of any kind. It makes two keys under "SageFin Desktop selftest-tpm …"
// with a random password, uses them, sees the TPM refuse them without the password and with a
// wrong one, and deletes them. Windows Hello is not asked: native/windows/hello-check.mjs does
// that, with a person at the computer.
//
// The two refusals each count once against the TPM's lockout for wrong passwords, which forgets
// them over time; nothing else here does. One line of JSON per check, then a summary; it exits 0
// only when every check passed.

using System.Diagnostics;
using System.Security.Cryptography;

namespace SageFinKeys;

static class SelfTest
{
    const string Service = "selftest-tpm";

    public static int Run()
    {
        var failed = 0;
        void Report(string check, bool ok, string detail = "")
        {
            if (!ok) failed++;
            Program.Answer(w =>
            {
                w.WriteString("check", check);
                w.WriteBoolean("ok", ok);
                if (detail.Length > 0) w.WriteString("detail", detail);
            });
        }
        string Status() => $"0x{Tpm.LastStatus:X8}";

        Report("not a Remote Desktop session", !Program.RemoteSession());
        var tpm = Tpm.Available();
        Report("the Platform Crypto Provider opens and is hardware", tpm);
        if (!tpm) return Summary(failed + 1);

        var agreementName = Program.KeyName(Service, Program.Role.Agreement);
        var signingName = Program.KeyName(Service, Program.Role.Signing);
        try
        {
            Tpm.Delete(agreementName);
            Tpm.Delete(signingName);

            var secret = new DerivedSecret(RandomNumberGenerator.GetBytes(256));
            var wrong = new DerivedSecret(RandomNumberGenerator.GetBytes(256));

            var timer = Stopwatch.StartNew();
            var agreementPublic = Tpm.Create(agreementName, Tpm.Algorithm.EcdhP256, secret.UsageAuth(Program.Role.Agreement));
            var signingPublic = Tpm.Create(signingName, Tpm.Algorithm.EcdsaP256, secret.UsageAuth(Program.Role.Signing));
            Report("two P-256 keys made in the TPM, with a password each", agreementPublic.Length == 65 && signingPublic.Length == 65, $"{timer.ElapsedMilliseconds} ms");

            Report("the public keys read back without a password",
                Tpm.PublicKeyOf(agreementName)?.AsSpan().SequenceEqual(agreementPublic) == true
                && Tpm.PublicKeyOf(signingName)?.AsSpan().SequenceEqual(signingPublic) == true);

            Report("neither private key can be exported", Tpm.PrivateExportRefused(agreementName) && Tpm.PrivateExportRefused(signingName));

            // With the password: a signature that verifies, and the same agreement a software peer makes.
            var message = RandomNumberGenerator.GetBytes(48);
            timer.Restart();
            var signature = Tpm.Sign(signingName, secret.UsageAuth(Program.Role.Signing), message);
            using (var verifier = ECDsa.Create(Parameters(signingPublic)))
                Report("with its password the signing key signs, and the signature verifies",
                    verifier.VerifyData(message, signature, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation),
                    $"{timer.ElapsedMilliseconds} ms");

            using (var peer = ECDiffieHellman.Create(ECCurve.NamedCurves.nistP256))
            {
                var p = peer.ExportParameters(false);
                var peerPublic = new byte[65];
                peerPublic[0] = 0x04;
                p.Q.X!.CopyTo(peerPublic, 1);
                p.Q.Y!.CopyTo(peerPublic, 33);
                timer.Restart();
                var shared = Tpm.Agree(agreementName, secret.UsageAuth(Program.Role.Agreement), peerPublic);
                var elapsed = timer.ElapsedMilliseconds;
                using var ours = ECDiffieHellman.Create(Parameters(agreementPublic));
                var expected = peer.DeriveRawSecretAgreement(ours.PublicKey);
                Report("with its password the agreement key agrees, matching a software peer", shared.AsSpan().SequenceEqual(expected), $"{elapsed} ms");

                // Without the password, and with a wrong one: refused, at once, with no dialog.
                timer.Restart();
                var unsigned = Refused(() => Tpm.Sign(signingName, null, message));
                Report("without a password the TPM refuses the signing key, and nothing asks", unsigned is not null && timer.ElapsedMilliseconds < 5000,
                    $"{unsigned ?? "it signed"} ({Status()}) in {timer.ElapsedMilliseconds} ms");

                timer.Restart();
                var misagreed = Refused(() => Tpm.Agree(agreementName, wrong.UsageAuth(Program.Role.Agreement), peerPublic));
                Report("with a wrong password the TPM refuses the agreement key, and nothing asks", misagreed is not null && timer.ElapsedMilliseconds < 5000,
                    $"{misagreed ?? "it agreed"} ({Status()}) in {timer.ElapsedMilliseconds} ms");
            }

            // The derivation: the same signature gives the same values, and the three are different.
            var fixedSignature = new byte[256];
            for (var i = 0; i < fixedSignature.Length; i++) fixedSignature[i] = (byte)i;
            using (var a = new DerivedSecret((byte[])fixedSignature.Clone()))
            using (var b = new DerivedSecret((byte[])fixedSignature.Clone()))
            {
                var values = new[] { a.UsageAuth(Program.Role.Agreement), a.UsageAuth(Program.Role.Signing), a.Check() };
                Report("the passwords and check value come from the signature alone, and differ",
                    values[0].AsSpan().SequenceEqual(b.UsageAuth(Program.Role.Agreement))
                    && values[2].AsSpan().SequenceEqual(b.Check())
                    && !values[0].AsSpan().SequenceEqual(values[1]) && !values[0].AsSpan().SequenceEqual(values[2]) && !values[1].AsSpan().SequenceEqual(values[2]),
                    Convert.ToHexString(values[2]));
            }
        }
        catch (Failure f)
        {
            Report("the checks ran to the end", false, $"{f.Code} ({Status()})");
        }
        finally
        {
            try
            {
                Tpm.Delete(agreementName);
                Tpm.Delete(signingName);
                Report("the test keys are deleted", Tpm.PublicKeyOf(agreementName) is null && Tpm.PublicKeyOf(signingName) is null);
            }
            catch (Failure f)
            {
                Report("the test keys are deleted", false, $"{f.Code} ({Status()})");
            }
        }
        return Summary(failed);
    }

    static int Summary(int failed)
    {
        Program.Answer(w => w.WriteString("selfTest", failed == 0 ? "passed" : $"{failed} failed"));
        return failed == 0 ? 0 : 1;
    }

    static string? Refused(Func<byte[]> use)
    {
        try { use(); return null; }
        catch (Failure f) { return f.Code; }
    }

    static ECParameters Parameters(byte[] x963) => new()
    {
        Curve = ECCurve.NamedCurves.nistP256,
        Q = new ECPoint { X = x963[1..33], Y = x963[33..65] },
    };
}
