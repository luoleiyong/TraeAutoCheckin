using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows.Forms;
using Microsoft.Win32;

namespace TraeAutoCheckin
{
    internal static class AppPaths
    {
        public static string ExePath { get { return Application.ExecutablePath; } }
        public static string ExeDir { get { return Path.GetDirectoryName(Application.ExecutablePath); } }
        public static string AppDir
        {
            get
            {
                string b = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                return Path.Combine(b, "TraeAutoCheckin");
            }
        }
        public static string CoreDir { get { return Path.Combine(AppDir, "core"); } }
        public static string ScriptPath { get { return Path.Combine(CoreDir, "checkin.mjs"); } }
        public static string LogDir { get { return Path.Combine(AppDir, "logs"); } }
        public static string ConfigPath { get { return Path.Combine(AppDir, "config.ini"); } }
        public static string RunLog { get { return Path.Combine(LogDir, "run.log"); } }

        public static void EnsureDirs()
        {
            Directory.CreateDirectory(AppDir);
            Directory.CreateDirectory(CoreDir);
            Directory.CreateDirectory(LogDir);
        }
    }

    internal static class CoreBundle
    {
        private static readonly string[] Files = new string[] {
            "checkin.mjs", "trae-crypto.mjs", "trae-platform.mjs", "trae-auth.mjs", "trae-api.mjs",
            "trae-accounts.mjs", "trae-checkin-core.mjs"
        };

        public static void Extract()
        {
            AppPaths.EnsureDirs();
            Assembly asm = Assembly.GetExecutingAssembly();
            foreach (string name in Files)
            {
                Stream s = asm.GetManifestResourceStream("TraeAutoCheckin.core." + name);
                if (s == null) throw new Exception("安装包损坏：缺少内嵌脚本 " + name);
                byte[] buf;
                using (s)
                {
                    buf = new byte[s.Length];
                    int off = 0;
                    while (off < buf.Length)
                    {
                        int n = s.Read(buf, off, buf.Length - off);
                        if (n <= 0) break;
                        off += n;
                    }
                }
                string target = Path.Combine(AppPaths.CoreDir, name);
                bool need = true;
                if (File.Exists(target))
                {
                    try
                    {
                        byte[] old = File.ReadAllBytes(target);
                        if (old.Length == buf.Length) need = false;
                    }
                    catch { need = true; }
                }
                if (need) File.WriteAllBytes(target, buf);
            }
        }
    }

    internal class Runner
    {
        public string Path;
        public bool IsElectron;
        public string Display
        {
            get { return (IsElectron ? "Trae 内置 Node" : "node.exe") + "  (" + Path + ")"; }
        }
    }

    internal static class Runtime
    {
        private const string TaskName = "TraeAutoCheckin";
        public static string TaskNameValue { get { return TaskName; } }

        public static string FindOnPath(string exe)
        {
            string pathVar = Environment.GetEnvironmentVariable("PATH") ?? "";
            foreach (string p in pathVar.Split(';'))
            {
                if (string.IsNullOrWhiteSpace(p)) continue;
                try
                {
                    string full = Path.Combine(p.Trim(), exe);
                    if (File.Exists(full)) return full;
                }
                catch { }
            }
            return null;
        }

        public static string FindTraeExe(string hint)
        {
            List<string> cands = new List<string>();
            if (!string.IsNullOrEmpty(hint)) cands.Add(hint);
            string envExe = Environment.GetEnvironmentVariable("TRAE_EXE");
            if (!string.IsNullOrEmpty(envExe)) cands.Add(envExe);

            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            foreach (string n in new string[] { "Trae CN", "Trae", "Trae CN Insiders" })
                cands.Add(Path.Combine(local, "Programs", n, n + ".exe"));

            foreach (string pf in new string[] {
                Environment.GetEnvironmentVariable("ProgramFiles"),
                Environment.GetEnvironmentVariable("ProgramFiles(x86)") })
            {
                if (string.IsNullOrEmpty(pf)) continue;
                foreach (string n in new string[] { "Trae CN", "Trae" })
                    cands.Add(Path.Combine(pf, n, n + ".exe"));
            }
            cands.Add(@"D:\Trae CN\Trae CN.exe");
            cands.Add(@"C:\Trae CN\Trae CN.exe");

            // 注册表卸载项
            try
            {
                foreach (RegistryKey root in new RegistryKey[] {
                    Registry.LocalMachine, Registry.CurrentUser })
                {
                    using (RegistryKey un = root.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"))
                    {
                        if (un == null) continue;
                        foreach (string sub in un.GetSubKeyNames())
                        {
                            using (RegistryKey k = un.OpenSubKey(sub))
                            {
                                if (k == null) continue;
                                string dn = Convert.ToString(k.GetValue("DisplayName"));
                                if (string.IsNullOrEmpty(dn) || dn.IndexOf("Trae", StringComparison.OrdinalIgnoreCase) < 0) continue;
                                string loc = Convert.ToString(k.GetValue("InstallLocation"));
                                if (!string.IsNullOrEmpty(loc))
                                {
                                    foreach (string n in new string[] { "Trae CN", "Trae" })
                                        cands.Add(Path.Combine(loc, n + ".exe"));
                                    cands.Add(Path.Combine(loc, "Trae CN.exe"));
                                }
                                string icon = Convert.ToString(k.GetValue("DisplayIcon"));
                                if (!string.IsNullOrEmpty(icon))
                                {
                                    icon = icon.Trim('"');
                                    int comma = icon.LastIndexOf(',');
                                    if (comma > 0) icon = icon.Substring(0, comma);
                                    cands.Add(icon);
                                }
                            }
                        }
                    }
                }
            }
            catch { }

            foreach (string c in cands)
            {
                try { if (!string.IsNullOrEmpty(c) && File.Exists(c)) return c; }
                catch { }
            }
            return null;
        }

        public static Runner ResolveRunner(string traeHint)
        {
            string localNode = Path.Combine(AppPaths.ExeDir, "node.exe");
            if (File.Exists(localNode)) return new Runner { Path = localNode, IsElectron = false };

            string n1 = FindOnPath("node.exe");
            if (n1 != null) return new Runner { Path = n1, IsElectron = false };

            foreach (string c in new string[] {
                @"C:\Program Files\nodejs\node.exe",
                @"C:\Program Files (x86)\nodejs\node.exe",
                @"D:\node\node.exe" })
            {
                if (File.Exists(c)) return new Runner { Path = c, IsElectron = false };
            }

            string trae = FindTraeExe(traeHint);
            if (!string.IsNullOrEmpty(trae)) return new Runner { Path = trae, IsElectron = true };
            return null;
        }

        private static string Q(string s)
        {
            return "\"" + (s ?? "").Replace("\"", "\\\"") + "\"";
        }

        /** 每次执行前由界面填充：TRAE_USERDATA / TRAE_EXE */
        public static Dictionary<string, string> BaseEnv = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        public static ProcessStartInfo BuildStartInfo(Runner runner, string extra)
        {
            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = runner.Path;
            psi.Arguments = Q(AppPaths.ScriptPath) + (string.IsNullOrEmpty(extra) ? "" : " " + extra);
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.RedirectStandardInput = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardErrorEncoding = Encoding.UTF8;
            psi.WorkingDirectory = AppPaths.CoreDir;
            foreach (KeyValuePair<string, string> kv in BaseEnv)
            {
                if (!string.IsNullOrEmpty(kv.Value)) psi.EnvironmentVariables[kv.Key] = kv.Value;
            }
            if (runner.IsElectron) psi.EnvironmentVariables["ELECTRON_RUN_AS_NODE"] = "1";
            return psi;
        }
        public static int Run(Runner runner, string extra, Action<string> onLine, int timeoutMs)
        {
            using (Process p = new Process())
            {
                p.StartInfo = BuildStartInfo(runner, extra);
                DataReceivedEventHandler h = delegate(object o, DataReceivedEventArgs e)
                {
                    if (e.Data != null && onLine != null) onLine(e.Data);
                };
                p.OutputDataReceived += h;
                p.ErrorDataReceived += h;
                p.Start();
                p.BeginOutputReadLine();
                p.BeginErrorReadLine();
                try { p.StandardInput.Close(); } catch { }
                if (!p.WaitForExit(timeoutMs))
                {
                    try { p.Kill(); } catch { }
                    return -1;
                }
                p.WaitForExit();
                return p.ExitCode;
            }
        }

        /** 执行并收集全部输出 */
        public static string Capture(Runner runner, string extra, int timeoutMs)
        {
            StringBuilder sb = new StringBuilder();
            Run(runner, extra, delegate(string line) { sb.AppendLine(line); }, timeoutMs);
            return sb.ToString();
        }

        /** 解析 KEY=VALUE 输出 */
        public static Dictionary<string, string> ParseKv(string text)
        {
            Dictionary<string, string> map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            if (string.IsNullOrEmpty(text)) return map;
            foreach (string raw in text.Split('\n'))
            {
                string line = raw.Trim();
                int eq = line.IndexOf('=');
                if (eq <= 0) continue;
                string k = line.Substring(0, eq).Trim();
                string v = line.Substring(eq + 1).Trim();
                if (Regex.IsMatch(k, "^[A-Za-z_][A-Za-z0-9_]*$")) map[k] = v;
            }
            return map;
        }
    }

    internal static class TaskSched
    {
        private static string RunHidden(string file, string args)
        {
            ProcessStartInfo psi = new ProcessStartInfo(file, args);
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardErrorEncoding = Encoding.UTF8;
            using (Process p = Process.Start(psi))
            {
                string o = p.StandardOutput.ReadToEnd();
                string e = p.StandardError.ReadToEnd();
                p.WaitForExit(30000);
                return (o + "\n" + e).Trim();
            }
        }

        public static Dictionary<string, string> Query()
        {
            string n = Runtime.TaskNameValue;
            string ps = "$n='" + n + "';" +
                "$t=Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue;" +
                "if($t){$i=Get-ScheduledTaskInfo -TaskName $n;'EXISTS=1';" +
                "'NEXT=' + $i.NextRunTime.ToString('yyyy-MM-dd HH:mm');" +
                "'LAST=' + $i.LastTaskResult;'EXEC=' + $t.Actions[0].Execute}else{'EXISTS=0'}";
            string o = RunHidden("powershell.exe", "-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command " + Quote(ps));
            return Runtime.ParseKv(o);
        }

        public static bool Exists()
        {
            string v;
            if (!Query().TryGetValue("EXISTS", out v)) return false;
            return v == "1";
        }

        public static string NextRunTime()
        {
            string o = RunHidden("schtasks.exe", "/Query /TN " + Runtime.TaskNameValue + " /V /FO LIST");
            Match m = Regex.Match(o, "(?im)^\\s*(Next Run Time|下次运行时间)\\s*[:：]\\s*(.+?)\\s*$");
            if (m.Success) return m.Groups[2].Value.Trim();
            return "";
        }

        public static string LastResult()
        {
            string o = RunHidden("schtasks.exe", "/Query /TN " + Runtime.TaskNameValue + " /V /FO LIST");
            Match m = Regex.Match(o, "(?im)^\\s*(Last Result|上次结果)\\s*[:：]\\s*(.+?)\\s*$");
            if (m.Success) return m.Groups[2].Value.Trim();
            return "";
        }

        public static string Create(string hhmm)
        {
            string ps = string.Join("; ", new string[] {
                "$ErrorActionPreference='Stop'",
                "$a=New-ScheduledTaskAction -Execute '" + AppPaths.ExePath.Replace("'", "''") + "' -Argument '--silent' -WorkingDirectory '" + AppPaths.ExeDir.Replace("'", "''") + "'",
                "$t=New-ScheduledTaskTrigger -Daily -At '" + hhmm + "'",
                "$s=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5)",
                "$u=$env:USERDOMAIN + [char]92 + $env:USERNAME",
                "$p=New-ScheduledTaskPrincipal -UserId $u -LogonType Interactive -RunLevel Limited",
                "Register-ScheduledTask -TaskName '" + Runtime.TaskNameValue + "' -Action $a -Trigger $t -Settings $s -Principal $p -Description 'Trae auto check-in' -Force | Out-Null"
            });
            string outp = RunHidden("powershell.exe", "-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command " + Quote(ps));
            return outp;
        }

        public static string Delete()
        {
            return RunHidden("schtasks.exe", "/Delete /TN " + Runtime.TaskNameValue + " /F");
        }

        public static string RunNow()
        {
            return RunHidden("schtasks.exe", "/Run /TN " + Runtime.TaskNameValue);
        }

        public static string Quote(string s)
        {
            return "\"" + (s ?? "").Replace("\"", "\\\"") + "\"";
        }
    }

    internal static class Config
    {
        private static Dictionary<string, string> map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        public static string Get(string key, string def)
        {
            string v;
            if (map.TryGetValue(key, out v) && !string.IsNullOrEmpty(v)) return v;
            return def;
        }

        public static void Set(string key, string value)
        {
            map[key] = value ?? "";
        }

        public static void Load()
        {
            try
            {
                if (!File.Exists(AppPaths.ConfigPath)) return;
                foreach (string line in File.ReadAllLines(AppPaths.ConfigPath, Encoding.UTF8))
                {
                    int eq = line.IndexOf('=');
                    if (eq <= 0) continue;
                    map[line.Substring(0, eq).Trim()] = line.Substring(eq + 1).Trim();
                }
            }
            catch { }
        }

        public static void Save()
        {
            try
            {
                AppPaths.EnsureDirs();
                StringBuilder sb = new StringBuilder();
                foreach (KeyValuePair<string, string> kv in map) sb.AppendLine(kv.Key + "=" + kv.Value);
                File.WriteAllText(AppPaths.ConfigPath, sb.ToString(), Encoding.UTF8);
            }
            catch { }
        }
    }
}