// The TPM side of the helper: P-256 keys made, opened and used through the Microsoft Platform
// Crypto Provider, with NCrypt called directly so every call carries NCRYPT_SILENT_FLAG. Silent
// matters: a key whose password is missing or wrong must fail here, never fall back to Windows's
// older "enter the password for this key" dialog, which is not Windows Hello.

using System.Runtime.InteropServices;
using System.Security.Cryptography;

namespace SageFinKeys;

static unsafe partial class Tpm
{
    const string Provider = "Microsoft Platform Crypto Provider";
    const int Silent = 0x40; // NCRYPT_SILENT_FLAG
    const int Overwrite = 0x80; // NCRYPT_OVERWRITE_KEY_FLAG
    const int BadKeyset = unchecked((int)0x80090016); // NTE_BAD_KEYSET: no key by that name
    const int ImplHardware = 0x1; // NCRYPT_IMPL_HARDWARE_FLAG
    const int EcdhP256PublicMagic = 0x314B4345; // BCRYPT_ECDH_PUBLIC_P256_MAGIC

    public enum Algorithm { EcdhP256, EcdsaP256 }

    /// <summary>Whether the TPM's provider opens and says it is hardware. Nothing prompts.</summary>
    public static bool Available()
    {
        if (NCryptOpenStorageProvider(out var provider, Provider, 0) != 0) return false;
        try
        {
            int impl = 0, size;
            return NCryptGetProperty(provider, "Impl Type", (byte*)&impl, 4, out size, 0) == 0 && (impl & ImplHardware) != 0;
        }
        finally { NCryptFreeObject(provider); }
    }

    /// <summary>A new key under <paramref name="name"/>, which the TPM uses only with <paramref name="usageAuth"/>.</summary>
    public static byte[] Create(string name, Algorithm algorithm, byte[] usageAuth)
    {
        using var provider = OpenProvider();
        Check(NCryptCreatePersistedKey(provider.Handle, out var key, algorithm == Algorithm.EcdhP256 ? "ECDH_P256" : "ECDSA_P256", name, 0, Overwrite));
        try
        {
            int none = 0; // NCRYPT_EXPORT_POLICY: no export of the private key, ever.
            Check(NCryptSetProperty(key, "Export Policy", (byte*)&none, 4, 0));
            SetUsageAuth(key, usageAuth);
            Check(NCryptFinalizeKey(key, Silent));
            return PublicKey(key);
        }
        catch
        {
            NCryptDeleteKey(key, 0);
            key = 0;
            throw;
        }
        finally
        {
            if (key != 0) NCryptFreeObject(key);
            CryptographicOperations.ZeroMemory(usageAuth);
        }
    }

    /// <summary>The key's public key, 65 bytes (0x04, X, Y), or null when there is no such key. No password needed.</summary>
    public static byte[]? PublicKeyOf(string name)
    {
        using var provider = OpenProvider();
        var status = NCryptOpenKey(provider.Handle, out var key, name, 0, Silent);
        if (status == BadKeyset) return null;
        Check(status);
        try { return PublicKey(key); }
        finally { NCryptFreeObject(key); }
    }

    public static void Delete(string name)
    {
        using var provider = OpenProvider();
        var status = NCryptOpenKey(provider.Handle, out var key, name, 0, Silent);
        if (status == BadKeyset) return;
        Check(status);
        // NCryptDeleteKey frees the handle, whether it succeeds or not. The provider refuses
        // NCRYPT_SILENT_FLAG here (NTE_BAD_FLAGS), and deleting needs no password, so asks nothing.
        Check(NCryptDeleteKey(key, 0));
    }

    /// <summary>ECDSA P-256 over SHA-256 of <paramref name="data"/>: r then s, 32 bytes each, as CryptoKit's rawRepresentation.</summary>
    public static byte[] Sign(string name, byte[]? usageAuth, byte[] data)
    {
        var hash = SHA256.HashData(data);
        return WithKey(name, usageAuth, key =>
        {
            var signature = new byte[64];
            int size;
            fixed (byte* h = hash)
            fixed (byte* s = signature)
                Check(NCryptSignHash(key, 0, h, hash.Length, s, signature.Length, out size, Silent));
            if (size != 64) throw new Failure("failed");
            return signature;
        });
    }

    /// <summary>The raw P-256 agreement with <paramref name="peer"/> (65 bytes, 0x04, X, Y): the shared X, big-endian, as CryptoKit's.</summary>
    public static byte[] Agree(string name, byte[]? usageAuth, byte[] peer)
    {
        var blob = PeerBlob(peer);
        return WithKey(name, usageAuth, key =>
        {
            using var provider = OpenProvider();
            nint peerKey;
            fixed (byte* b = blob)
                Check(NCryptImportKey(provider.Handle, 0, "ECCPUBLICBLOB", 0, out peerKey, b, blob.Length, Silent));
            nint secret = 0;
            try
            {
                Check(NCryptSecretAgreement(key, peerKey, out secret, Silent));
                var raw = new byte[32];
                int size;
                fixed (byte* r = raw)
                    Check(NCryptDeriveKey(secret, "TRUNCATE" /* BCRYPT_KDF_RAW_SECRET */, 0, r, raw.Length, out size, 0));
                if (size != 32) throw new Failure("failed");
                Array.Reverse(raw); // CNG gives the raw secret little-endian.
                return raw;
            }
            finally
            {
                if (secret != 0) NCryptFreeObject(secret);
                NCryptFreeObject(peerKey);
            }
        });
    }

    /// <summary>Whether the TPM refuses to export the key's private half (the self-test's question).</summary>
    public static bool PrivateExportRefused(string name)
    {
        using var provider = OpenProvider();
        Check(NCryptOpenKey(provider.Handle, out var key, name, 0, Silent));
        try
        {
            var blob = new byte[256];
            int size;
            fixed (byte* b = blob)
                return NCryptExportKey(key, 0, "ECCPRIVATEBLOB", 0, b, blob.Length, out size, Silent) != 0;
        }
        finally { NCryptFreeObject(key); }
    }

    /// <summary>
    /// Opens the key silently, gives it its password, and uses it once. A null password gives it
    /// none, which only the self-test does, to see the TPM refuse.
    /// </summary>
    static T WithKey<T>(string name, byte[]? usageAuth, Func<nint, T> use)
    {
        using var provider = OpenProvider();
        var status = NCryptOpenKey(provider.Handle, out var key, name, 0, Silent);
        if (status == BadKeyset) throw new Failure("no-keys");
        Check(status);
        try
        {
            if (usageAuth is not null) SetUsageAuth(key, usageAuth);
            return use(key);
        }
        finally
        {
            NCryptFreeObject(key);
            if (usageAuth is not null) CryptographicOperations.ZeroMemory(usageAuth);
        }
    }

    static void SetUsageAuth(nint key, byte[] usageAuth)
    {
        fixed (byte* a = usageAuth)
            Check(NCryptSetProperty(key, "PCP_USAGEAUTH", a, usageAuth.Length, 0));
    }

    static byte[] PublicKey(nint key)
    {
        var blob = new byte[8 + 64];
        int size;
        fixed (byte* b = blob)
            Check(NCryptExportKey(key, 0, "ECCPUBLICBLOB", 0, b, blob.Length, out size, 0));
        if (size != blob.Length || BitConverter.ToInt32(blob, 4) != 32) throw new Failure("failed");
        var x963 = new byte[65];
        x963[0] = 0x04;
        blob.AsSpan(8, 64).CopyTo(x963.AsSpan(1));
        return x963;
    }

    /// <summary>The peer's key as CNG takes it, once it is known to be a point on P-256.</summary>
    static byte[] PeerBlob(byte[] peer)
    {
        if (peer.Length != 65 || peer[0] != 0x04) throw new Failure("failed");
        var parameters = new ECParameters
        {
            Curve = ECCurve.NamedCurves.nistP256,
            Q = new ECPoint { X = peer[1..33], Y = peer[33..65] },
        };
        try
        {
            using var check = ECDiffieHellman.Create();
            check.ImportParameters(parameters); // Refuses a point that is not on the curve.
        }
        catch (CryptographicException) { throw new Failure("failed"); }
        var blob = new byte[8 + 64];
        BitConverter.GetBytes(EcdhP256PublicMagic).CopyTo(blob, 0);
        BitConverter.GetBytes(32).CopyTo(blob, 4);
        peer.AsSpan(1, 64).CopyTo(blob.AsSpan(8));
        return blob;
    }

    sealed class ProviderHandle(nint handle) : IDisposable
    {
        public nint Handle { get; } = handle;
        public void Dispose() => NCryptFreeObject(Handle);
    }

    static ProviderHandle OpenProvider()
    {
        if (NCryptOpenStorageProvider(out var provider, Provider, 0) != 0) throw new Failure("no-tpm");
        return new ProviderHandle(provider);
    }

    /// <summary>The last NCrypt status that failed, for the self-test to report.</summary>
    public static int LastStatus { get; private set; }

    static void Check(int status)
    {
        if (status == 0) return;
        LastStatus = status;
        throw new Failure(status switch
        {
            // TPM_E_AUTHFAIL, TPM_20_E_AUTH_FAIL, TPM_20_E_BAD_AUTH: the password did not open the key.
            unchecked((int)0x80280001) or unchecked((int)0x8028008E) or unchecked((int)0x802800A2) => "tpm-refused",
            // TPM_E_DEFEND_LOCK_RUNNING, TPM_20_E_LOCKOUT: the TPM's lockout after too many wrong passwords.
            unchecked((int)0x80280803) or unchecked((int)0x80280921) => "tpm-locked-out",
            // NTE_PERM: the TPM refused a wrong password (measured on an AMD fTPM).
            unchecked((int)0x80090010) => "tpm-refused",
            // NTE_SILENT_CONTEXT: no password given, and the provider may not ask for one.
            unchecked((int)0x80090022) => "tpm-refused",
            _ => "tpm",
        });
    }

    [LibraryImport("ncrypt.dll", StringMarshalling = StringMarshalling.Utf16)]
    private static partial int NCryptOpenStorageProvider(out nint provider, string name, int flags);

    [LibraryImport("ncrypt.dll", StringMarshalling = StringMarshalling.Utf16)]
    private static partial int NCryptCreatePersistedKey(nint provider, out nint key, string algorithm, string? name, int legacySpec, int flags);

    [LibraryImport("ncrypt.dll", StringMarshalling = StringMarshalling.Utf16)]
    private static partial int NCryptOpenKey(nint provider, out nint key, string name, int legacySpec, int flags);

    [LibraryImport("ncrypt.dll", StringMarshalling = StringMarshalling.Utf16)]
    private static partial int NCryptSetProperty(nint obj, string property, byte* input, int size, int flags);

    [LibraryImport("ncrypt.dll", StringMarshalling = StringMarshalling.Utf16)]
    private static partial int NCryptGetProperty(nint obj, string property, byte* output, int size, out int result, int flags);

    [LibraryImport("ncrypt.dll")]
    private static partial int NCryptFinalizeKey(nint key, int flags);

    [LibraryImport("ncrypt.dll", StringMarshalling = StringMarshalling.Utf16)]
    private static partial int NCryptExportKey(nint key, nint exportKey, string blobType, nint parameters, byte* output, int size, out int result, int flags);

    [LibraryImport("ncrypt.dll", StringMarshalling = StringMarshalling.Utf16)]
    private static partial int NCryptImportKey(nint provider, nint importKey, string blobType, nint parameters, out nint key, byte* data, int size, int flags);

    [LibraryImport("ncrypt.dll")]
    private static partial int NCryptSignHash(nint key, nint padding, byte* hash, int hashSize, byte* signature, int signatureSize, out int result, int flags);

    [LibraryImport("ncrypt.dll")]
    private static partial int NCryptSecretAgreement(nint privateKey, nint publicKey, out nint secret, int flags);

    [LibraryImport("ncrypt.dll", StringMarshalling = StringMarshalling.Utf16)]
    private static partial int NCryptDeriveKey(nint secret, string kdf, nint parameters, byte* output, int size, out int result, int flags);

    [LibraryImport("ncrypt.dll")]
    private static partial int NCryptDeleteKey(nint key, int flags);

    [LibraryImport("ncrypt.dll")]
    private static partial int NCryptFreeObject(nint obj);
}
