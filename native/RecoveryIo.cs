using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

// All file traversal below the verified volume root uses single-component relative opens.
internal static class RecoveryIo {
    const uint DirectoryAccess = 0x1000A1; // SYNCHRONIZE | READ_ATTRIBUTES | TRAVERSE | LIST_DIRECTORY
    const uint ReadAccess = 0x100081;
    const uint WriteAccess = 0x100083;
    const uint DirectoryOptions = 0x200021; // OPEN_REPARSE_POINT | SYNCHRONOUS_IO_NONALERT | DIRECTORY_FILE
    const uint FileOptions = 0x200060;      // OPEN_REPARSE_POINT | SYNCHRONOUS_IO_NONALERT | NON_DIRECTORY_FILE
    const int MaxPackage = 161 * 1024 * 1024;
    const int MaxDatabase = 32 * 1024 * 1024;
    const int MaxRecoveryEvidence = 32 * 1024;
    static readonly string[] RestoreFiles = {
        "mvp.sqlite3", "worklog.sqlite3", "growth.sqlite3", "student-intake.sqlite3", "operations.sqlite3"
    };
    static readonly string[] MarkerContents = {
        "mvp-v1\n", "worklog-v1\n", "growth-profile-v1\n", "student-intake-v1\n", "operations-v1\n"
    };

    [StructLayout(LayoutKind.Sequential)]
    struct UnicodeString { public ushort Length, MaximumLength; public IntPtr Buffer; }
    [StructLayout(LayoutKind.Sequential)]
    struct ObjectAttributes {
        public int Length;
        public IntPtr RootDirectory, ObjectName;
        public uint Attributes;
        public IntPtr SecurityDescriptor, SecurityQualityOfService;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IoStatus { public IntPtr Status, Information; }
    [StructLayout(LayoutKind.Sequential)]
    struct FileInfo {
        public uint Attributes, CreatedLow, CreatedHigh, AccessedLow, AccessedHigh, WrittenLow, WrittenHigh;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }

    [DllImport("ntdll.dll")]
    static extern int NtCreateFile(out IntPtr handle, uint access, ref ObjectAttributes obj, out IoStatus status,
        IntPtr allocation, uint attributes, uint share, uint disposition, uint options, IntPtr ea, uint eaLength);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition,
        uint options, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInfo info);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder path, uint capacity, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool GetVolumeInformationByHandleW(SafeFileHandle handle, IntPtr volumeName, uint volumeCapacity,
        IntPtr serial, IntPtr maxComponent, IntPtr flags, StringBuilder fsName, uint fsCapacity);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern uint GetDriveTypeW(string root);

    static void Check(bool valid, string message) {
        if (!valid) throw new IOException(message);
    }
    static FileInfo CheckEntry(SafeFileHandle handle, bool directory) {
        FileInfo data;
        if (!GetFileInformationByHandle(handle, out data)) throw new Win32Exception(Marshal.GetLastWin32Error());
        Check((data.Attributes & 0x400) == 0 && ((data.Attributes & 0x10) != 0) == directory, "Unexpected reparse point or entry type.");
        if (!directory) Check(data.Links == 1, "Expected a single-link file.");
        return data;
    }

    static string EntryId(SafeFileHandle handle, bool directory) {
        var info = CheckEntry(handle, directory);
        return info.Volume.ToString("x8") + ":" + info.IndexHigh.ToString("x8") + info.IndexLow.ToString("x8");
    }
    static void PlainName(string name) {
        Check(name.Length > 0 && name.Length <= 255 && !Regex.IsMatch(name, "[\\x00-\\x1f\\\\/:*?\"<>|]") &&
            !name.EndsWith(".") && !name.EndsWith(" ") && name[0] != ' ', "Invalid path component.");
    }

    static SafeFileHandle Child(SafeFileHandle parent, string name, bool directory, bool create) {
        PlainName(name);
        var chars = Marshal.StringToHGlobalUni(name);
        var ptr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UnicodeString)));
        try {
            var unicode = new UnicodeString { Buffer = chars, Length = (ushort)(name.Length * 2), MaximumLength = (ushort)((name.Length + 1) * 2) };
            Marshal.StructureToPtr(unicode, ptr, false);
            var attr = new ObjectAttributes {
                Length = Marshal.SizeOf(typeof(ObjectAttributes)), RootDirectory = parent.DangerousGetHandle(),
                ObjectName = ptr, Attributes = 0x40 // OBJ_CASE_INSENSITIVE
            };
            IntPtr raw;
            IoStatus ios;
            int status = NtCreateFile(out raw, directory ? DirectoryAccess : create ? WriteAccess : ReadAccess,
                ref attr, out ios, IntPtr.Zero, directory ? 0u : 0x80u, create && !directory ? 0u : 1u,
                create ? 2u : 1u, directory ? DirectoryOptions : FileOptions, IntPtr.Zero, 0);
            GC.KeepAlive(parent);
            Check(status == 0, "Relative open/create failed (NTSTATUS " + status.ToString("X8") + ").");
            var child = new SafeFileHandle(raw, true);
            try { CheckEntry(child, directory); return child; }
            catch { child.Dispose(); throw; }
        } finally { Marshal.FreeHGlobal(ptr); Marshal.FreeHGlobal(chars); }
    }

    sealed class PinnedPath : IDisposable {
        readonly List<SafeFileHandle> directories = new List<SafeFileHandle>();
        public SafeFileHandle Current { get { return directories[directories.Count - 1]; } }
        public PinnedPath(string path) {
            Check(Regex.IsMatch(path, "^[A-Za-z]:\\\\") && Path.GetFullPath(path).Equals(path, StringComparison.OrdinalIgnoreCase),
                "Expected an absolute local drive path.");
            string root = path.Substring(0, 3);
            Check(GetDriveTypeW(root) == 3, "Expected a fixed local drive.");
            try {
                var volume = CreateFileW(root, DirectoryAccess, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
                directories.Add(volume);
                if (volume.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
                CheckEntry(volume, true);
                var canonical = new StringBuilder(32);
                uint chars = GetFinalPathNameByHandleW(volume, canonical, (uint)canonical.Capacity, 0);
                Check(chars != 0 && chars < canonical.Capacity && canonical.ToString().Equals(@"\\?\" + root, StringComparison.OrdinalIgnoreCase),
                    "Redirected drive roots are unsupported.");
                var filesystem = new StringBuilder(32);
                Check(GetVolumeInformationByHandleW(volume, IntPtr.Zero, 0, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero,
                    filesystem, (uint)filesystem.Capacity) && filesystem.ToString() == "NTFS", "Expected NTFS.");
                if (path.Length > 3) foreach (string part in path.Substring(3).Split('\\')) Add(part, false);
            } catch { Dispose(); throw; }
        }
        public void Add(string name, bool create) { directories.Add(Child(Current, name, true, create)); }
        public void Dispose() {
            for (int i = directories.Count - 1; i >= 0; i--) directories[i].Dispose();
        }
    }

    static FileStream Output(SafeFileHandle directory, string name) {
        var h = Child(directory, name, false, true);
        try { return new FileStream(h, FileAccess.ReadWrite, 65536); }
        catch { h.Dispose(); throw; }
    }

    static void WriteVerified(FileStream output, Stream source, int size) {
        byte[] buffer = new byte[65536];
        using (var sha = SHA256.Create()) {
            int remaining = size;
            while (remaining != 0) {
                int count = source.Read(buffer, 0, Math.Min(remaining, buffer.Length));
                Check(count > 0, "Input ended before its declared length.");
                sha.TransformBlock(buffer, 0, count, buffer, 0);
                output.Write(buffer, 0, count);
                remaining -= count;
            }
            sha.TransformFinalBlock(buffer, 0, 0);
            output.Flush(true);
            Check(output.Length == size, "Written file has an unexpected length.");
            output.Position = 0;
            byte[] readback;
            using (var verifier = SHA256.Create()) readback = verifier.ComputeHash(output);
            Check(Convert.ToBase64String(readback) == Convert.ToBase64String(sha.Hash), "Readback differs from supplied bytes.");
            CheckEntry(output.SafeFileHandle, false);
        }
    }

    static void Publish(string root, string name, int length) {
        Check(Regex.IsMatch(name, @"\Asw-backup-[a-f0-9]{32}\z") && length > 0 && length <= MaxPackage, "Invalid backup output.");
        using (var path = new PinnedPath(root)) {
            path.Add(name, true);
            using (var output = Output(path.Current, "workspace.swbackup")) {
                // Receive the body, verify and flush it, then commit the final completion bytes.
                var input = Console.OpenStandardInput();
                Check(length > 32, "Missing backup completion bytes.");
                WriteVerified(output, input, length - 32);
                var final = new BinaryReader(input).ReadBytes(32);
                Check(final.Length == 32 && input.ReadByte() == -1, "Incomplete or oversized backup stream.");
                output.Position = length - 32;
                output.Write(final, 0, final.Length);
                output.Flush(true);
                Check(output.Length == length, "Published length differs.");
                output.Position = length - 32;
                var readback = new BinaryReader(output).ReadBytes(32);
                Check(Convert.ToBase64String(final) == Convert.ToBase64String(readback), "Completion bytes differ.");
                CheckEntry(output.SafeFileHandle, false);
            }
        }
    }

    static void ReadInput(string file) {
        var parent = Path.GetDirectoryName(file);
        var leaf = Path.GetFileName(file);
        Check(leaf.EndsWith(".swbackup", StringComparison.OrdinalIgnoreCase), "Expected a .swbackup file.");
        using (var path = new PinnedPath(parent))
        using (var h = Child(path.Current, leaf, false, false))
        using (var input = new FileStream(h, FileAccess.Read, 65536)) {
            Check(input.Length > 0 && input.Length <= MaxPackage, "Backup size out of range.");
            input.CopyTo(Console.OpenStandardOutput());
            CheckEntry(h, false);
        }
    }

    static string Marker(int index, string m1Version) {
        return index == 0 ? "mvp-v" + m1Version + "\n" : MarkerContents[index];
    }

    static void Restore(string root, string name, bool forActivation, int count, string m1Version) {
        Check(Regex.IsMatch(name, forActivation ? @"\Asw-m2d-active-[a-f0-9]{32}\z" : @"\Asw-m2d-restore-[a-f0-9]{32}\z"),
            "Invalid recovery profile name.");
        var reader = new BinaryReader(Console.OpenStandardInput());
        int evidenceSize = reader.ReadInt32();
        Check(evidenceSize > 0 && evidenceSize <= MaxRecoveryEvidence, "Invalid recovery evidence length.");
        byte[] evidence = reader.ReadBytes(evidenceSize);
        Check(evidence.Length == evidenceSize, "Incomplete recovery evidence.");
        using (var path = new PinnedPath(root)) {
            string parentId = EntryId(path.Current, true);
            path.Add(name, true);
            string containerId = EntryId(path.Current, true);
            path.Add("profile", true);
            var profile = path.Current;
            path.Add(forActivation ? "data" : "recovery", true);
            var opened = new List<FileStream>();
            var filenames = new List<string>();
            try {
                for (int i = 0; i < count; i++) {
                    int size = reader.ReadInt32();
                    Check(size >= 512 && size <= MaxDatabase, "Invalid restored SQLite image length.");
                    string filename = RestoreFiles[i];
                    var output = Output(path.Current, filename);
                    opened.Add(output);
                    filenames.Add(filename);
                    WriteVerified(output, reader.BaseStream, size);
                    string marker = filename.Replace(".sqlite3", ".initialized");
                    output = Output(path.Current, marker);
                    opened.Add(output);
                    filenames.Add(marker);
                    byte[] bytes = Encoding.ASCII.GetBytes(Marker(i, m1Version));
                    WriteVerified(output, new MemoryStream(bytes), bytes.Length);
                }
                Check(reader.BaseStream.ReadByte() == -1, "Unexpected recovery payload.");
                // The record describes the verified files. It does not authorize a subsequent path-based open.
                var ids = new List<string>();
                for (int i = 0; i < opened.Count; i++) {
                    ids.Add("\"" + filenames[i] + "\":\"" + EntryId(opened[i].SafeFileHandle, false) + "\"");
                }
                using (var ready = Output(profile, "restore.ready")) {
                    string record = "{\"format\":\"sw-recovery-evidence-v1\",\"profileName\":\"" + name +
                        "\",\"directoryIds\":{\"parent\":\"" + parentId + "\",\"container\":\"" + containerId +
                        "\",\"profile\":\"" + EntryId(profile, true) + "\",\"data\":\"" + EntryId(path.Current, true) +
                        "\"},\"verifiedFiles\":{" + String.Join(",", ids) +
                        "},\"packageEvidenceBase64\":\"" + Convert.ToBase64String(evidence) + "\"}\n";
                    byte[] complete = Encoding.ASCII.GetBytes(record);
                    WriteVerified(ready, new MemoryStream(complete), complete.Length);
                }
            } finally {
                foreach (var file in opened) file.Dispose();
            }
        }
    }

    static byte[] ReadRestored(SafeFileHandle directory, string filename, int min, int max) {
        using (var handle = Child(directory, filename, false, false))
        using (var input = new FileStream(handle, FileAccess.Read, 65536))
        using (var reader = new BinaryReader(input)) {
            long length = input.Length;
            Check(length >= min && length <= max, "Unexpected recovery file length.");
            byte[] bytes = reader.ReadBytes((int)length);
            Check(bytes.Length == length && input.ReadByte() == -1, "Incomplete recovery file.");
            CheckEntry(handle, false);
            return bytes;
        }
    }

    static void CheckNames(string path, params string[] expected) {
        var names = new HashSet<string>(expected, StringComparer.Ordinal);
        foreach (string entry in Directory.GetFileSystemEntries(path))
            Check(names.Remove(Path.GetFileName(entry)), "Unexpected recovery entry.");
        Check(names.Count == 0, "Missing recovery entry.");
    }

    static void Inspect(string root, string name, int count, string m1Version) {
        Check(Regex.IsMatch(name, @"\Asw-m2d-restore-[a-f0-9]{32}\z"), "Invalid recovery profile name.");
        using (var path = new PinnedPath(root)) {
            path.Add(name, false);
            path.Add("profile", false);
            string profile = Path.Combine(root, name, "profile");
            CheckNames(profile, "recovery", "restore.ready");
            byte[] record = ReadRestored(path.Current, "restore.ready", 1, MaxRecoveryEvidence * 2);
            path.Add("recovery", false);
            var expected = new List<string>();
            for (int i = 0; i < count; i++) {
                expected.Add(RestoreFiles[i]);
                expected.Add(RestoreFiles[i].Replace(".sqlite3", ".initialized"));
            }
            CheckNames(Path.Combine(profile, "recovery"), expected.ToArray());
            var output = new BinaryWriter(Console.OpenStandardOutput());
            output.Write(record.Length);
            output.Write(record);
            for (int i = 0; i < count; i++) {
                string marker = RestoreFiles[i].Replace(".sqlite3", ".initialized");
                var bytes = ReadRestored(path.Current, marker, 1, 128);
                Check(Encoding.ASCII.GetString(bytes) == Marker(i, m1Version), "Recovery initialization marker differs.");
                var image = ReadRestored(path.Current, RestoreFiles[i], 512, MaxDatabase);
                output.Write(image.Length);
                output.Write(image);
            }
            output.Flush();
        }
    }

    public static int Main(string[] args) {
        try {
            if (args.Length == 4 && args[0] == "publish") Publish(args[1], args[2], Int32.Parse(args[3]));
            else if (args.Length == 2 && args[0] == "read") ReadInput(args[1]);
            else if ((args.Length == 3 || args.Length == 4 || args.Length == 5) &&
                     (args[0] == "restore" || args[0] == "activate" || args[0] == "inspect")) {
                string version = args.Length == 3 ? "1" : args[3];
                string m1Version = args.Length == 5 ? args[4] : "1";
                Check(version == "1" || version == "2", "Invalid recovery format.");
                Check(m1Version == "1" || (version == "2" && (m1Version == "2" || m1Version == "3")), "Invalid student database version.");
                int count = version == "2" ? RestoreFiles.Length : RestoreFiles.Length - 1;
                if (args[0] == "inspect") Inspect(args[1], args[2], count, m1Version);
                else Restore(args[1], args[2], args[0] == "activate", count, m1Version);
            }
            else throw new IOException("Invalid recovery command.");
            return 0;
        } catch (Exception error) {
            Console.Error.WriteLine(error.Message);
            return 1;
        }
    }
}
