using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace TraeAutoCheckin
{
    internal static class SetupProgram
    {
        public const string ProductName = "Trae 自动签到助手";
        public const string ProductVersion = "2.0";
        public const string Publisher = "3270423617@qq.com";
        public const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\TraeAutoCheckin";
        public const string PayloadResource = "Installer.payload.exe";

        [STAThread]
        private static void Main(string[] args)
        {
            bool uninstall = args.Length > 0 && args[0] == "--uninstall";
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            if (uninstall)
            {
                bool quiet = false;
                for (int i = 0; i < args.Length; i++) if (args[i] == "--silent") quiet = true;
                if (!quiet && MessageBox.Show("确定要卸载 " + ProductName + " 吗？\n\n将删除程序文件、快捷方式和计划任务。",
                    "卸载确认", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
                try { Uninstaller.Run(quiet); }
                catch (Exception ex)
                {
                    if (!quiet) MessageBox.Show("卸载出错：" + ex.Message, "错误", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    Environment.ExitCode = 1;
                }
                return;
            }

            // 静默安装：Setup.exe --silent [目录]
            if (args.Length > 0 && args[0] == "--silent")
            {
                string dir = args.Length > 1 ? args[1] : SetupUtil.DefaultInstallDir();
                try
                {
                    SetupUtil.DoInstall(dir, true, true, true);
                    return;
                }
                catch (Exception ex)
                {
                    MessageBox.Show("静默安装失败：" + ex.Message, "错误", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    Environment.ExitCode = 1;
                    return;
                }
            }

            Application.Run(new SetupForm());
        }
    }

    internal static class SetupUtil
    {
        public static string DefaultInstallDir()
        {
            string baseDir = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            return Path.Combine(baseDir, "Programs", "TraeAutoCheckin");
        }

        public static string DesktopDir()
        {
            return Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
        }

        public static string StartMenuDir()
        {
            string p = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
            return Path.Combine(p, "Trae 自动签到助手");
        }

        public static bool IsInstalled(out string dir)
        {
            dir = "";
            try
            {
                using (RegistryKey k = Registry.CurrentUser.OpenSubKey(SetupProgram.UninstallKey))
                {
                    if (k == null) return false;
                    string loc = Convert.ToString(k.GetValue("InstallLocation"));
                    if (string.IsNullOrEmpty(loc)) return false;
                    dir = loc;
                    return File.Exists(Path.Combine(loc, "TraeAutoCheckin.exe"));
                }
            }
            catch { return false; }
        }

        public static void CreateShortcut(string lnkPath, string target, string workDir, string desc)
        {
            object shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
            object sc = shell.GetType().InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { lnkPath });
            Type t = sc.GetType();
            t.InvokeMember("TargetPath", BindingFlags.SetProperty, null, sc, new object[] { target });
            t.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, sc, new object[] { workDir });
            t.InvokeMember("Description", BindingFlags.SetProperty, null, sc, new object[] { desc });
            t.InvokeMember("IconLocation", BindingFlags.SetProperty, null, sc, new object[] { target + ",0" });
            t.InvokeMember("Save", BindingFlags.InvokeMethod, null, sc, null);
        }

        public static int RunHidden(string file, string args, int timeoutMs)
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo(file, args);
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                using (Process p = Process.Start(psi))
                {
                    p.WaitForExit(timeoutMs);
                    return p.HasExited ? p.ExitCode : -1;
                }
            }
            catch { return -1; }
        }

        public static void WriteEntry(string dir, string target, string uninst)
        {
            using (RegistryKey k = Registry.CurrentUser.CreateSubKey(SetupProgram.UninstallKey))
            {
                k.SetValue("DisplayName", SetupProgram.ProductName);
                k.SetValue("DisplayVersion", SetupProgram.ProductVersion);
                k.SetValue("Publisher", SetupProgram.Publisher);
                k.SetValue("DisplayIcon", target + ",0");
                k.SetValue("InstallLocation", dir);
                k.SetValue("UninstallString", "\"" + uninst + "\" --uninstall");
                k.SetValue("QuietUninstallString", "\"" + uninst + "\" --uninstall");
                k.SetValue("NoModify", 1, RegistryValueKind.DWord);
                k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                try { k.SetValue("EstimatedSize", (int)(new FileInfo(target).Length / 1024), RegistryValueKind.DWord); } catch { }
                k.SetValue("InstallDate", DateTime.Now.ToString("yyyyMMdd"));
            }
        }

        /** 完整安装流程（界面与静默共用） */
        public static string DoInstall(string dir, bool desktop, bool startMenu, bool quiet)
        {
            Directory.CreateDirectory(dir);
            string target = Path.Combine(dir, "TraeAutoCheckin.exe");
            string uninst = Path.Combine(dir, "uninstall.exe");

            File.WriteAllBytes(target, ReadPayload());
            try { File.Copy(Application.ExecutablePath, uninst, true); } catch { }

            if (desktop)
            {
                try
                {
                    CreateShortcut(Path.Combine(DesktopDir(), "Trae 自动签到助手.lnk"), target, dir, SetupProgram.ProductName);
                }
                catch { }
            }
            if (startMenu)
            {
                try
                {
                    string sm = StartMenuDir();
                    Directory.CreateDirectory(sm);
                    CreateShortcut(Path.Combine(sm, "Trae 自动签到助手.lnk"), target, dir, SetupProgram.ProductName);
                }
                catch { }
            }

            WriteEntry(dir, target, uninst);
            return target;
        }

        public static byte[] ReadPayload()
        {
            Assembly asm = Assembly.GetExecutingAssembly();
            using (Stream s = asm.GetManifestResourceStream(SetupProgram.PayloadResource))
            {
                if (s == null) throw new Exception("安装包损坏：缺少内嵌程序");
                byte[] buf = new byte[s.Length];
                int off = 0;
                while (off < buf.Length)
                {
                    int n = s.Read(buf, off, buf.Length - off);
                    if (n <= 0) break;
                    off += n;
                }
                return buf;
            }
        }
    }
}
namespace TraeAutoCheckin
{
    internal static class Uninstaller
    {
        public static void Run(bool quiet)
        {
            string dir = Path.GetDirectoryName(Application.ExecutablePath);

            // 1. 移除计划任务
            SetupUtil.RunHidden("schtasks.exe", "/Delete /TN TraeAutoCheckin /F", 20000);

            // 2. 移除快捷方式
            TryDelete(Path.Combine(SetupUtil.DesktopDir(), "Trae 自动签到助手.lnk"));
            try
            {
                string sm = SetupUtil.StartMenuDir();
                if (Directory.Exists(sm)) Directory.Delete(sm, true);
            }
            catch { }

            // 3. 移除注册表卸载项
            try { Registry.CurrentUser.DeleteSubKeyTree(SetupProgram.UninstallKey, false); } catch { }

            // 4. 删除用户数据（询问；静默模式保留，便于重装后沿用配置）
            try
            {
                bool wipe = false;
                if (!quiet)
                {
                    wipe = MessageBox.Show("是否同时删除程序配置与日志？\n（" + Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TraeAutoCheckin") + "）",
                        "卸载", MessageBoxButtons.YesNo, MessageBoxIcon.Question) == DialogResult.Yes;
                }
                if (wipe)
                {
                    string appDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TraeAutoCheckin");
                    if (Directory.Exists(appDir)) Directory.Delete(appDir, true);
                }
            }
            catch { }

            // 5. 延迟删除安装目录（自身文件被占用）
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo("cmd.exe",
                    "/c ping 127.0.0.1 -n 4 >nul & rmdir /s /q \"" + dir + "\"");
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.WindowStyle = ProcessWindowStyle.Hidden;
                Process.Start(psi);
            }
            catch { }

            if (!quiet) MessageBox.Show("已卸载 " + SetupProgram.ProductName + "。", "完成", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }

        private static void TryDelete(string path)
        {
            try { if (File.Exists(path)) File.Delete(path); } catch { }
        }
    }

    internal class SetupForm : Form
    {
        private TextBox txtDir;
        private RichTextBox txtLicense;
        private CheckBox chkAgree;
        private CheckBox chkDesktop;
        private CheckBox chkStartMenu;
        private CheckBox chkLaunch;
        private FlatButton btnInstall;
        private FlatButton btnExit;
        private FlatButton btnBrowse;
        private ProgressBar bar;
        private Label lblStatus;
        private bool installed = false;

        public SetupForm()
        {
            Text = "安装 " + SetupProgram.ProductName + " v" + SetupProgram.ProductVersion;
            ClientSize = new Size(660, 620);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(0xF5, 0xF6, 0xF8);
            Font = new Font("Microsoft YaHei UI", 9f, FontStyle.Regular, GraphicsUnit.Point);
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

            // 顶栏
            Panel head = new Panel();
            head.Dock = DockStyle.Top;
            head.Height = 92;
            head.BackColor = Color.White;
            head.Paint += delegate(object s, PaintEventArgs e)
            {
                using (Pen pen = new Pen(Color.FromArgb(0xE5, 0xE7, 0xEB))) e.Graphics.DrawLine(pen, 0, head.Height - 1, head.Width, head.Height - 1);
            };
            Controls.Add(head);

            PictureBox pic = new PictureBox();
            pic.Size = new Size(40, 40);
            pic.Location = new Point(24, 24);
            try { pic.Image = Icon.ToBitmap(); } catch { }
            head.Controls.Add(pic);

            Label t = new Label();
            t.Text = "安装 " + SetupProgram.ProductName;
            t.Font = new Font("Microsoft YaHei UI", 14f, FontStyle.Bold, GraphicsUnit.Point);
            t.ForeColor = Color.FromArgb(0x1F, 0x23, 0x29);
            t.AutoSize = true;
            t.Location = new Point(76, 18);
            head.Controls.Add(t);

            Label sub = new Label();
            sub.Text = "版本 " + SetupProgram.ProductVersion + "　·　禁止商用，仅限个人使用　·　" + SetupProgram.Publisher;
            sub.Font = new Font("Microsoft YaHei UI", 9f, FontStyle.Regular, GraphicsUnit.Point);
            sub.ForeColor = Color.FromArgb(0x6B, 0x72, 0x80);
            sub.AutoSize = true;
            sub.Location = new Point(78, 48);
            head.Controls.Add(sub);

            // 协议
            Label lt = new Label();
            lt.Text = "许可协议（请滚动阅读后勾选同意）";
            lt.Font = new Font("Microsoft YaHei UI", 9.5f, FontStyle.Bold, GraphicsUnit.Point);
            lt.ForeColor = Color.FromArgb(0x1F, 0x23, 0x29);
            lt.AutoSize = true;
            lt.Location = new Point(20, 106);
            Controls.Add(lt);

            txtLicense = new RichTextBox();
            txtLicense.Location = new Point(20, 132);
            txtLicense.Size = new Size(620, 208);
            txtLicense.ReadOnly = true;
            txtLicense.BorderStyle = BorderStyle.FixedSingle;
            txtLicense.BackColor = Color.White;
            txtLicense.Font = new Font("Microsoft YaHei UI", 9f, FontStyle.Regular, GraphicsUnit.Point);
            txtLicense.Text = LicenseText;
            Controls.Add(txtLicense);

            chkAgree = new CheckBox();
            chkAgree.Text = "我已完整阅读并同意上述全部条款";
            chkAgree.AutoSize = true;
            chkAgree.Location = new Point(22, 348);
            chkAgree.ForeColor = Color.FromArgb(0x1F, 0x23, 0x29);
            chkAgree.CheckedChanged += delegate { UpdateInstallButton(); };
            Controls.Add(chkAgree);

            // 安装位置
            Label ld = new Label();
            ld.Text = "安装位置";
            ld.AutoSize = true;
            ld.Location = new Point(22, 386);
            ld.ForeColor = Color.FromArgb(0x6B, 0x72, 0x80);
            Controls.Add(ld);

            txtDir = new TextBox();
            txtDir.Location = new Point(96, 382);
            txtDir.Size = new Size(462, 26);
            txtDir.Text = SetupUtil.DefaultInstallDir();
            Controls.Add(txtDir);

            btnBrowse = new FlatButton();
            btnBrowse.Text = "浏览…";
            btnBrowse.ButtonKind = FlatButton.Kind.Ghost;
            btnBrowse.Size = new Size(78, 28);
            btnBrowse.Location = new Point(564, 381);
            btnBrowse.Click += delegate { BrowseDir(); };
            Controls.Add(btnBrowse);
            // 选项
            chkDesktop = new CheckBox();
            chkDesktop.Text = "创建桌面快捷方式";
            chkDesktop.AutoSize = true;
            chkDesktop.Checked = true;
            chkDesktop.Location = new Point(96, 420);
            chkDesktop.ForeColor = Color.FromArgb(0x1F, 0x23, 0x29);
            Controls.Add(chkDesktop);

            chkStartMenu = new CheckBox();
            chkStartMenu.Text = "创建开始菜单快捷方式";
            chkStartMenu.AutoSize = true;
            chkStartMenu.Checked = true;
            chkStartMenu.Location = new Point(290, 420);
            chkStartMenu.ForeColor = Color.FromArgb(0x1F, 0x23, 0x29);
            Controls.Add(chkStartMenu);

            chkLaunch = new CheckBox();
            chkLaunch.Text = "安装完成后立即运行";
            chkLaunch.AutoSize = true;
            chkLaunch.Checked = true;
            chkLaunch.Location = new Point(96, 446);
            chkLaunch.ForeColor = Color.FromArgb(0x1F, 0x23, 0x29);
            Controls.Add(chkLaunch);

            bar = new ProgressBar();
            bar.Location = new Point(20, 486);
            bar.Size = new Size(620, 8);
            bar.Style = ProgressBarStyle.Continuous;
            Controls.Add(bar);

            lblStatus = new Label();
            lblStatus.Text = "准备就绪，勾选协议后点击「开始安装」。";
            lblStatus.AutoSize = true;
            lblStatus.ForeColor = Color.FromArgb(0x6B, 0x72, 0x80);
            lblStatus.Location = new Point(20, 502);
            Controls.Add(lblStatus);

            btnInstall = new FlatButton();
            btnInstall.Text = "开始安装";
            btnInstall.ButtonKind = FlatButton.Kind.Primary;
            btnInstall.Size = new Size(130, 36);
            btnInstall.Location = new Point(372, 544);
            btnInstall.Enabled = false;
            btnInstall.Click += delegate { DoInstall(); };
            Controls.Add(btnInstall);

            btnExit = new FlatButton();
            btnExit.Text = "退出";
            btnExit.ButtonKind = FlatButton.Kind.Ghost;
            btnExit.Size = new Size(100, 36);
            btnExit.Location = new Point(512, 544);
            btnExit.Click += delegate { Close(); };
            Controls.Add(btnExit);

            Label foot = new Label();
            foot.Text = "本程序仅限个人使用，禁止商用。技术支持：" + SetupProgram.Publisher;
            foot.AutoSize = true;
            foot.Font = new Font("Microsoft YaHei UI", 8.5f, FontStyle.Regular, GraphicsUnit.Point);
            foot.ForeColor = Color.FromArgb(0x9A, 0xA1, 0xAC);
            foot.Location = new Point(22, 592);
            Controls.Add(foot);
        }

        private const string LicenseText =
            "【使用声明】\n\n" +
            "一、使用范围\n" +
            "    本软件为作者个人编写的辅助工具，仅限个人学习、研究与自用。\n" +
            "    严禁任何形式的商业使用，包括但不限于：售卖、租赁、代签到收费、\n" +
            "    捆绑分发、集成进商业产品、作为付费服务的一部分提供。\n\n" +
            "二、分发限制\n" +
            "    未经作者书面许可，不得对程序进行二次打包、修改后发布、\n" +
            "    上传至任何下载站或资源站进行传播。\n\n" +
            "三、数据处理\n" +
            "    本软件不收集、不上传任何个人数据。所有账号凭据仅从本机\n" +
            "    Trae 配置中读取并在本机使用，不经过任何第三方服务器。\n\n" +
            "四、风险自担\n" +
            "    使用本软件可能违反 Trae 官方用户协议，由此产生的账号异常、\n" +
            "    积分收回、限制登录等后果，均由使用者自行承担。\n" +
            "    作者不对使用本软件造成的任何直接或间接损失负责。\n\n" +
            "五、其他\n" +
            "    若你不同意上述任何一条，请立即关闭安装程序并删除已下载的文件。\n" +
            "    继续安装即视为你已完整阅读并接受上述条款。\n\n" +
            "联系方式：" + SetupProgram.Publisher;

        private void UpdateInstallButton()
        {
            btnInstall.Enabled = chkAgree.Checked && !string.IsNullOrEmpty(txtDir.Text.Trim());
        }

        private void BrowseDir()
        {
            FolderBrowserDialog dlg = new FolderBrowserDialog();
            dlg.Description = "选择安装目录";
            dlg.SelectedPath = txtDir.Text;
            if (dlg.ShowDialog(this) == DialogResult.OK)
            {
                txtDir.Text = dlg.SelectedPath;
                UpdateInstallButton();
            }
        }

        private void SetStatus(string text)
        {
            lblStatus.Text = text;
        }

        private void DoInstall()
        {
            if (!chkAgree.Checked)
            {
                MessageBox.Show(this, "请先阅读并勾选同意许可协议。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            string dir = txtDir.Text.Trim();
            if (string.IsNullOrEmpty(dir))
            {
                MessageBox.Show(this, "请填写安装位置。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            btnInstall.Enabled = false;
            btnExit.Enabled = false;
            btnBrowse.Enabled = false;
            bar.Value = 0;

            string target = Path.Combine(dir, "TraeAutoCheckin.exe");
            string uninst = Path.Combine(dir, "uninstall.exe");

            try
            {
                Directory.CreateDirectory(dir);
                SetStatus("正在释放程序文件…");
                bar.Value = 20;
                File.WriteAllBytes(target, SetupUtil.ReadPayload());

                SetStatus("正在注册卸载程序…");
                bar.Value = 45;
                File.Copy(Application.ExecutablePath, uninst, true);

                if (chkDesktop.Checked)
                {
                    SetStatus("正在创建桌面快捷方式…");
                    bar.Value = 60;
                    SetupUtil.CreateShortcut(Path.Combine(SetupUtil.DesktopDir(), "Trae 自动签到助手.lnk"),
                        target, dir, SetupProgram.ProductName);
                }

                if (chkStartMenu.Checked)
                {
                    SetStatus("正在创建开始菜单项…");
                    bar.Value = 72;
                    string sm = SetupUtil.StartMenuDir();
                    Directory.CreateDirectory(sm);
                    SetupUtil.CreateShortcut(Path.Combine(sm, "Trae 自动签到助手.lnk"),
                        target, dir, SetupProgram.ProductName);
                }

                SetStatus("正在写入卸载信息…");
                bar.Value = 85;
                WriteUninstallEntry(dir, target, uninst);

                bar.Value = 100;
                SetStatus("安装完成。");
                installed = true;

                if (chkLaunch.Checked)
                {
                    try { Process.Start(new ProcessStartInfo(target) { WorkingDirectory = dir, UseShellExecute = true }); }
                    catch { }
                }

                DialogResult r = MessageBox.Show(this,
                    SetupProgram.ProductName + " 已安装到：\n" + dir + "\n\n是否立即关闭安装程序？",
                    "安装完成", MessageBoxButtons.YesNo, MessageBoxIcon.Information);
                if (r == DialogResult.Yes) Close();
                else { btnExit.Enabled = true; btnInstall.Text = "重新安装"; btnInstall.Enabled = true; }
            }
            catch (Exception ex)
            {
                bar.Value = 0;
                SetStatus("安装失败：" + ex.Message);
                btnInstall.Enabled = true;
                btnExit.Enabled = true;
                btnBrowse.Enabled = true;
                MessageBox.Show(this, "安装失败：\n" + ex.Message + "\n\n若提示拒绝访问，请改用用户目录（默认路径）。",
                    "错误", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void WriteUninstallEntry(string dir, string target, string uninst)
        {
            using (RegistryKey k = Registry.CurrentUser.CreateSubKey(SetupProgram.UninstallKey))
            {
                k.SetValue("DisplayName", SetupProgram.ProductName);
                k.SetValue("DisplayVersion", SetupProgram.ProductVersion);
                k.SetValue("Publisher", SetupProgram.Publisher);
                k.SetValue("DisplayIcon", target + ",0");
                k.SetValue("InstallLocation", dir);
                k.SetValue("UninstallString", "\"" + uninst + "\" --uninstall");
                k.SetValue("QuietUninstallString", "\"" + uninst + "\" --uninstall");
                k.SetValue("NoModify", 1, RegistryValueKind.DWord);
                k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                try { k.SetValue("EstimatedSize", (int)(new FileInfo(target).Length / 1024), RegistryValueKind.DWord); } catch { }
                k.SetValue("InstallDate", DateTime.Now.ToString("yyyyMMdd"));
            }
        }
    }
}