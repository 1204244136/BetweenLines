param(
  [ValidateSet("file", "folder")]
  [string]$Mode = "file",
  # 起始目录：调用方按导入入口（原文 / 主文本 / 参考文本）各自推导，空值表示沿用系统记忆。
  [string]$InitialDir = "",
  # 每个导入入口一个稳定 GUID，让 Windows 自身记住的「上次位置」也按入口分开。
  [string]$ClientGuid = "2B25D048-9026-4C30-A916-E559C747E4C3",
  [switch]$Check
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$source = @'
using System;
using System.Runtime.InteropServices;

namespace BetweenLines.NativePathPicker
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    internal struct FilterSpec
    {
        [MarshalAs(UnmanagedType.LPWStr)] public string Name;
        [MarshalAs(UnmanagedType.LPWStr)] public string Pattern;

        public FilterSpec(string name, string pattern)
        {
            Name = name;
            Pattern = pattern;
        }
    }

    [Flags]
    internal enum DialogOptions : uint
    {
        PickFolders = 0x00000020,
        ForceFileSystem = 0x00000040,
        NoChangeDirectory = 0x00000008,
        PathMustExist = 0x00000800,
        FileMustExist = 0x00001000
    }

    internal enum DisplayName : uint
    {
        FileSystemPath = 0x80058000
    }

    [ComImport]
    [Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IShellItem
    {
        void BindToHandler(IntPtr bindingContext, ref Guid handlerId, ref Guid interfaceId, out IntPtr result);
        void GetParent(out IShellItem parent);
        void GetDisplayName(DisplayName displayName, out IntPtr name);
        void GetAttributes(uint mask, out uint attributes);
        void Compare(IShellItem shellItem, uint hint, out int order);
    }

    [ComImport]
    [Guid("42f85136-db7e-439c-85f1-e4075d135fc8")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IFileDialog
    {
        [PreserveSig] int Show(IntPtr owner);
        void SetFileTypes(uint count, [MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 0)] FilterSpec[] filters);
        void SetFileTypeIndex(uint index);
        void GetFileTypeIndex(out uint index);
        void Advise(IntPtr events, out uint cookie);
        void Unadvise(uint cookie);
        void SetOptions(DialogOptions options);
        void GetOptions(out DialogOptions options);
        void SetDefaultFolder(IShellItem item);
        void SetFolder(IShellItem item);
        void GetFolder(out IShellItem item);
        void GetCurrentSelection(out IShellItem item);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
        void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
        void GetResult(out IShellItem item);
        void AddPlace(IShellItem item, uint placement);
        void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension);
        void Close(int result);
        void SetClientGuid(ref Guid clientGuid);
        void ClearClientData();
        void SetFilter(IntPtr filter);
    }

    [ComImport]
    [Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
    internal class FileOpenDialog
    {
    }

    public static class Picker
    {
        private const int Canceled = unchecked((int)0x800704C7);
        private static readonly Guid DefaultClientGuid = new Guid("2B25D048-9026-4C30-A916-E559C747E4C3");
        private static readonly Guid ShellItemGuid = new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe");

        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();

        [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
        private static extern void SHCreateItemFromParsingName(
            [MarshalAs(UnmanagedType.LPWStr)] string parsingName,
            IntPtr bindingContext,
            ref Guid interfaceId,
            [MarshalAs(UnmanagedType.Interface)] out IShellItem shellItem);

        // SetFolder 会覆盖系统记住的上次位置；SetDefaultFolder 只在没有记忆时才生效，
        // 因此各入口的默认目录必须走 SetFolder。
        private static void ApplyInitialDir(IFileDialog dialog, string initialDir)
        {
            if (String.IsNullOrEmpty(initialDir) || !System.IO.Directory.Exists(initialDir)) return;
            IShellItem folder = null;
            try
            {
                Guid shellItemGuid = ShellItemGuid;
                SHCreateItemFromParsingName(initialDir, IntPtr.Zero, ref shellItemGuid, out folder);
                if (folder != null) dialog.SetFolder(folder);
            }
            catch (Exception)
            {
                // 起始目录不可用时退回系统记忆位置，不阻断选择。
            }
            finally
            {
                if (folder != null) Marshal.FinalReleaseComObject(folder);
            }
        }

        public static string Pick(string mode, string initialDir, string clientGuid, bool check)
        {
            IFileDialog dialog = (IFileDialog)new FileOpenDialog();
            IShellItem result = null;
            try
            {
                bool pickFolder = String.Equals(mode, "folder", StringComparison.OrdinalIgnoreCase);
                DialogOptions options;
                dialog.GetOptions(out options);
                options |= DialogOptions.ForceFileSystem | DialogOptions.NoChangeDirectory | DialogOptions.PathMustExist;
                options |= pickFolder ? DialogOptions.PickFolders : DialogOptions.FileMustExist;
                dialog.SetOptions(options);

                Guid parsedClientGuid;
                if (!Guid.TryParse(clientGuid, out parsedClientGuid)) parsedClientGuid = DefaultClientGuid;
                dialog.SetClientGuid(ref parsedClientGuid);
                dialog.SetTitle(pickFolder ? "选择解压的 EPUB 文件夹" : "选择单个文件");
                dialog.SetOkButtonLabel(pickFolder ? "选择文件夹" : "选择文件");

                ApplyInitialDir(dialog, initialDir);

                if (!pickFolder)
                {
                    FilterSpec[] filters = new FilterSpec[] {
                        new FilterSpec("支持的文本文件", "*.txt;*.epub;*.docx;*.html;*.htm;*.odt;*.md;*.markdown;*.rtf"),
                        new FilterSpec("所有文件", "*.*")
                    };
                    dialog.SetFileTypes((uint)filters.Length, filters);
                    dialog.SetFileTypeIndex(1);
                }

                if (check) return String.Empty;

                int status = dialog.Show(GetForegroundWindow());
                if (status == Canceled)
                {
                    return String.Empty;
                }
                if (status < 0)
                {
                    Marshal.ThrowExceptionForHR(status);
                }

                dialog.GetResult(out result);
                IntPtr pathPointer;
                result.GetDisplayName(DisplayName.FileSystemPath, out pathPointer);
                try
                {
                    return Marshal.PtrToStringUni(pathPointer) ?? String.Empty;
                }
                finally
                {
                    Marshal.FreeCoTaskMem(pathPointer);
                }
            }
            finally
            {
                if (result != null) Marshal.FinalReleaseComObject(result);
                Marshal.FinalReleaseComObject(dialog);
            }
        }
    }
}
'@

# Windows PowerShell 5.1 needs this file saved as UTF-8 with BOM for localized labels.
Add-Type -TypeDefinition $source -Language CSharp

$selectedPath = [BetweenLines.NativePathPicker.Picker]::Pick($Mode, $InitialDir, $ClientGuid, $Check.IsPresent)
if ($selectedPath) {
  [Console]::Out.Write($selectedPath)
}
