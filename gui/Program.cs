using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace TraeAutoCheckin
{
    internal static class Program
    {
        private const string MutexName = "Global\\TraeAutoCheckin_SingleInstance_v2";

        [STAThread]
        private static int Main(string[] args)
        {
            bool silent = args.Length > 0 && args[0] == "--silent";

            try
            {
                CoreBundle.Extract();
                Config.Load();
            }
            catch (Exception ex)
            {
                if (!silent)
                {
                    MessageBox.Show("初始化失败：" + ex.Message, Theme.AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return 2;
                }
                WriteSilentLog("初始化失败：" + ex.Message);
                return 2;
            }

            if (silent) return RunSilent(args);

            bool createdNew;
            using (Mutex mutex = new Mutex(true, MutexName, out createdNew))
            {
                if (!createdNew)
                {
                    MessageBox.Show("程序已经在运行了，请查看任务栏。", Theme.AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Information);
                    return 0;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
                Application.ThreadException += delegate(object s, ThreadExceptionEventArgs e)
                {
                    WriteSilentLog("UI 异常：" + e.Exception);
                    MessageBox.Show(e.Exception.Message, "运行出错", MessageBoxButtons.OK, MessageBoxIcon.Error);
                };
                AppDomain.CurrentDomain.UnhandledException += delegate(object s, UnhandledExceptionEventArgs e)
                {
                    WriteSilentLog("未捕获异常：" + e.ExceptionObject);
                };

                // 启动声明页
                if (Config.Get("disclaimer_accepted", "0") != "1")
                {
                    using (DisclaimerForm d = new DisclaimerForm())
                    {
                        d.ShowDialog();
                        if (!d.Agreed) return 0;
                        if (d.DontShowAgain)
                        {
                            Config.Set("disclaimer_accepted", "1");
                            Config.Save();
                        }
                    }
                }

                Application.Run(new MainForm(args));
                GC.KeepAlive(mutex);
            }
            return 0;
        }

        private static int RunSilent(string[] args)
        {
            string traeHint = Config.Get("trae_exe", "");
            string userDataHint = Config.Get("user_data", "");

            Runner runner = Runtime.ResolveRunner(traeHint);
            if (runner == null)
            {
                WriteSilentLog("未找到 node.exe 或 Trae CN.exe，无法执行。");
                return 3;
            }
            Runtime.BaseEnv.Clear();
            if (!string.IsNullOrEmpty(traeHint)) Runtime.BaseEnv["TRAE_EXE"] = traeHint;
            if (!string.IsNullOrEmpty(userDataHint)) Runtime.BaseEnv["TRAE_USERDATA"] = userDataHint;

            string extra = "run --grants";
            for (int i = 1; i < args.Length; i++)
            {
                if (args[i] == "--grants") extra = "run --grants";
                else if (args[i] == "--no-grants") extra = "run";
            }

            StringBuilder all = new StringBuilder();
            int code = Runtime.Run(runner, extra, delegate(string line) { all.AppendLine(line); }, 300000);
            WriteSilentLog("[" + extra + "] exit=" + code + Environment.NewLine + all.ToString().TrimEnd());
            return code;
        }

        private static void WriteSilentLog(string text)
        {
            try
            {
                AppPaths.EnsureDirs();
                string line = "===== " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " =====" + Environment.NewLine
                            + text.TrimEnd() + Environment.NewLine;
                File.AppendAllText(Path.Combine(AppPaths.LogDir, "silent.log"), line, Encoding.UTF8);
            }
            catch { }
        }
    }
}