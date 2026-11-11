using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace TraeAutoCheckin
{
    internal class MainForm : Form
    {
        private TextBox txtTrae, txtData;
        private Label lblRunner, lblAccount, lblToken;
        private ListView lvAccounts;
        private StatusDot dotCheckin;
        private Label lblCheckin, lblMeta, lblCountdown;
        private FlatButton btnCheckin, btnStatus, btnToken, btnOpenLog, btnClear;
        private CheckBox chkEnable;
        private DateTimePicker dtpTime;
        private FlatButton btnSaveTime, btnRunTask, btnDeleteTask;
        private Label lblTask;
        private RichTextBox txtLog;
        private StatusStrip status;
        private ToolStripStatusLabel statusLabel;
        private ToolStripProgressBar progress;
        private Timer countTimer;

        private Runner runner;
        private string traeHint = "";
        private string userDataHint = "";
        private bool busy = false;
        private DateTime nextRun = DateTime.MinValue;

        public MainForm(string[] args)
        {
            Config.Load();
            traeHint = Config.Get("trae_exe", "");
            userDataHint = Config.Get("user_data", "");
            BuildUi();
        }

        private void BuildUi()
        {
            Text = Theme.AppTitle + "  v" + Theme.Version;
            ClientSize = new Size(900, 890);
            MinimumSize = new Size(884, 880);
            StartPosition = FormStartPosition.CenterScreen;
            Font = Theme.F(9f, FontStyle.Regular);
            BackColor = Theme.Bg;
            DoubleBuffered = true;
            try { Icon = Theme.BuildIcon(); } catch { }

            BuildHeader();
            BuildEnvCard();
            BuildAccountsCard();
            BuildStatCard();
            BuildActCard();
            BuildTimeCard();
            BuildLogCard();

            status = new StatusStrip();
            status.SizingGrip = false;
            status.BackColor = Color.White;
            statusLabel = new ToolStripStatusLabel("就绪");
            progress = new ToolStripProgressBar();
            progress.Visible = false;
            progress.Width = 110;
            status.Items.Add(progress);
            status.Items.Add(statusLabel);
            Controls.Add(status);

            countTimer = new Timer();
            countTimer.Interval = 1000;
            countTimer.Tick += delegate { UpdateCountdown(); };
            countTimer.Start();

            KeyPreview = true;
            KeyDown += delegate(object s, KeyEventArgs e)
            {
                if (e.KeyCode == Keys.F5) { AppendLog("──────── 手动刷新", 1); RefreshStatus(); RefreshTaskLabel(); }
            };

            const string LayoutVer = "3";
            string ww = Config.Get("layout_ver", "") == LayoutVer ? Config.Get("win_w", "") : "";
            string hh = Config.Get("layout_ver", "") == LayoutVer ? Config.Get("win_h", "") : "";
            int wi, hi;
            if (int.TryParse(ww, out wi) && int.TryParse(hh, out hi) && wi >= 884 && hi >= 700)
            {
                ClientSize = new Size(wi, hi);
            }
            else
            {
                StartPosition = FormStartPosition.CenterScreen;
            }

            FormClosing += delegate
            {
                Config.Set("win_w", ClientSize.Width.ToString());
                Config.Set("win_h", ClientSize.Height.ToString());
                Config.Set("layout_ver", LayoutVer);
                Config.Save();
            };

            Load += delegate { OnLoaded(); };
        }

        private void BuildHeader()
        {
            HeaderPanel head = new HeaderPanel();
            head.Location = new Point(0, 0);
            head.Size = new Size(900, 86);
            head.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            Controls.Add(head);

            StatusDot logo = new StatusDot();
            logo.DotColor = Theme.Primary;
            logo.Size = new Size(24, 24);
            logo.Location = new Point(22, 26);
            head.Controls.Add(logo);

            Label t = new Label();
            t.Text = Theme.AppTitle;
            t.Font = Theme.F(16f, FontStyle.Bold);
            t.ForeColor = Theme.Text;
            t.AutoSize = true;
            t.Location = new Point(56, 16);
            head.Controls.Add(t);

            Label v = new Label();
            v.Text = "v" + Theme.Version;
            v.Font = Theme.F(8.5f, FontStyle.Regular);
            v.ForeColor = Color.White;
            v.BackColor = Theme.Primary;
            v.AutoSize = false;
            v.TextAlign = ContentAlignment.MiddleCenter;
            v.Size = new Size(34, 18);
            v.Location = new Point(56 + t.PreferredWidth + 8, 22);
            head.Controls.Add(v);

            Label sub = new Label();
            sub.Text = "自动完成每日签到并领取积分 · 仅限个人使用，禁止商用";
            sub.Font = Theme.F(9f, FontStyle.Regular);
            sub.ForeColor = Theme.SubText;
            sub.AutoSize = true;
            sub.Location = new Point(58, 48);
            head.Controls.Add(sub);

            Label mail = new Label();
            mail.Text = "作者联系方式：" + Theme.Contact;
            mail.Font = Theme.F(9f, FontStyle.Regular);
            mail.ForeColor = Theme.SubText;
            mail.AutoSize = true;
            mail.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            mail.Location = new Point(head.Width - 462, 34);
            mail.Cursor = Cursors.Hand;
            mail.Click += delegate { CopyContact(); };
            head.Controls.Add(mail);

            FlatButton btnAbout = new FlatButton();
            btnAbout.Text = "使用声明";
            btnAbout.ButtonKind = FlatButton.Kind.Ghost;
            btnAbout.Size = new Size(96, 32);
            btnAbout.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            btnAbout.Location = new Point(head.Width - 118, 28);
            btnAbout.Click += delegate { ShowDisclaimer(); };
            head.Controls.Add(btnAbout);
        }
        private CardPanel MakeCard(int y, int h)
        {
            CardPanel c = new CardPanel();
            c.Location = new Point(14, y);
            c.Size = new Size(872, h);
            c.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            Controls.Add(c);
            return c;
        }

        private Label CardTitle(Control parent, string text)
        {
            Label l = new Label();
            l.Text = text;
            l.Font = Theme.F(10f, FontStyle.Bold);
            l.ForeColor = Theme.Text;
            l.AutoSize = true;
            l.Location = new Point(18, 12);
            parent.Controls.Add(l);
            return l;
        }

        private Label AddText(Control parent, string text, int x, int y, float size, Color color)
        {
            Label l = new Label();
            l.Text = text;
            l.Font = Theme.F(size, FontStyle.Regular);
            l.ForeColor = color;
            l.AutoSize = true;
            l.Location = new Point(x, y);
            parent.Controls.Add(l);
            return l;
        }

        private FlatButton Btn(Control parent, string text, int x, int y, int w, int h, FlatButton.Kind kind)
        {
            FlatButton b = new FlatButton();
            b.Text = text;
            b.ButtonKind = kind;
            b.Size = new Size(w, h);
            b.Location = new Point(x, y);
            parent.Controls.Add(b);
            return b;
        }

        private void BuildEnvCard()
        {
            CardPanel c = MakeCard(98, 168);
            CardTitle(c, "运行环境");

            AddText(c, "Trae 程序", 18, 46, 9f, Theme.SubText);
            txtTrae = new TextBox();
            txtTrae.Location = new Point(106, 42);
            txtTrae.Size = new Size(516, 26);
            txtTrae.ReadOnly = true;
            txtTrae.BorderStyle = BorderStyle.FixedSingle;
            txtTrae.BackColor = Color.FromArgb(0xFA, 0xFB, 0xFD);
            txtTrae.Font = Theme.F(9f, FontStyle.Regular);
            c.Controls.Add(txtTrae);

            FlatButton b1 = Btn(c, "浏览…", 630, 41, 72, 28, FlatButton.Kind.Ghost);
            b1.Click += delegate { BrowseTrae(); };

            AddText(c, "数据目录", 18, 82, 9f, Theme.SubText);
            txtData = new TextBox();
            txtData.Location = new Point(106, 78);
            txtData.Size = new Size(516, 26);
            txtData.ReadOnly = true;
            txtData.BorderStyle = BorderStyle.FixedSingle;
            txtData.BackColor = Color.FromArgb(0xFA, 0xFB, 0xFD);
            txtData.Font = Theme.F(9f, FontStyle.Regular);
            c.Controls.Add(txtData);

            FlatButton b2 = Btn(c, "浏览…", 630, 77, 72, 28, FlatButton.Kind.Ghost);
            b2.Click += delegate { BrowseData(); };

            FlatButton b3 = Btn(c, "重新检测", 714, 41, 140, 64, FlatButton.Kind.Primary);
            b3.Click += delegate { DetectEnvironment(); };

            lblRunner = AddText(c, "运行器：检测中…", 18, 116, 8.5f, Theme.SubText);
            lblAccount = AddText(c, "账号：—", 18, 138, 8.5f, Theme.SubText);
            lblToken = AddText(c, "Token：—", 470, 138, 8.5f, Theme.SubText);
        }

        private void BuildAccountsCard()
        {
            CardPanel c = MakeCard(278, 132);
            CardTitle(c, "账号库");

            lvAccounts = new ListView();
            lvAccounts.View = View.Details;
            lvAccounts.FullRowSelect = true;
            lvAccounts.MultiSelect = false;
            lvAccounts.HeaderStyle = ColumnHeaderStyle.Nonclickable;
            lvAccounts.BorderStyle = BorderStyle.None;
            lvAccounts.Font = Theme.F(8.5f, FontStyle.Regular);
            lvAccounts.BackColor = Color.White;
            lvAccounts.Location = new Point(18, 34);
            lvAccounts.Size = new Size(600, 86);
            lvAccounts.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            lvAccounts.Columns.Add("账号", 210);
            lvAccounts.Columns.Add("积分", 56);
            lvAccounts.Columns.Add("状态", 84);
            lvAccounts.Columns.Add("Token 到期", 110);
            lvAccounts.Columns.Add("标记", 80);
            c.Controls.Add(lvAccounts);

            FlatButton bImp = Btn(c, "导入当前账号", 628, 34, 112, 32, FlatButton.Kind.Ghost);
            bImp.Click += delegate { Go("import"); };

            FlatButton bAll = Btn(c, "全部签到", 628, 74, 112, 32, FlatButton.Kind.Primary);
            bAll.Click += delegate { Go("runall"); };
        }

        private void RefreshAccounts()
        {
            if (runner == null) return;
            Task.Run(delegate
            {
                try
                {
                    string o = Runtime.Capture(runner, "accountskv", 60000);
                    Dictionary<string, string> kv = Runtime.ParseKv(o);
                    BeginInvoke(new Action(delegate { ApplyAccounts(kv); }));
                }
                catch { }
            });
        }

        private void ApplyAccounts(Dictionary<string, string> kv)
        {
            int count = 0;
            int.TryParse(Get(kv, "COUNT"), out count);
            lvAccounts.BeginUpdate();
            lvAccounts.Items.Clear();
            for (int i = 1; i <= count; i++)
            {
                string v = Get(kv, "ACC" + i);
                if (string.IsNullOrEmpty(v)) continue;
                string[] f = v.Split('|');
                if (f.Length < 5) continue;
                ListViewItem it = new ListViewItem(f.Length > 1 && f[1] != "" ? f[1] : f[0]);
                it.SubItems.Add(f.Length > 2 && f[2] != "" ? f[2] : "-");
                it.SubItems.Add(StatusText(f.Length > 3 ? f[3] : ""));
                it.SubItems.Add(ShortDate(f.Length > 6 ? f[6] : ""));
                string mark = f.Length > 4 && f[4] == "1" ? "当前" : "";
                if (f.Length > 5 && f[5] == "1") mark = (mark == "" ? "" : mark + " ") + "冷却";
                it.SubItems.Add(mark);
                if (f.Length > 4 && f[4] == "1") it.ForeColor = Theme.Primary;
                lvAccounts.Items.Add(it);
            }
            lvAccounts.EndUpdate();
        }

        private string StatusText(string s)
        {
            if (s == "already") return "已签到";
            if (s == "pending") return "待签到";
            if (s == "claimed") return "刚签到";
            if (s == "error") return "失败";
            if (s == "cooldown") return "冷却中";
            if (s == "expired") return "Token 过期";
            if (s == "disabled") return "未开启";
            return s == "" ? "-" : s;
        }

        private string ShortDate(string iso)
        {
            if (string.IsNullOrEmpty(iso)) return "-";
            DateTime dt;
            if (DateTime.TryParse(iso, out dt)) return dt.ToLocalTime().ToString("MM-dd HH:mm");
            return iso;
        }
        private void BuildStatCard()
        {
            CardPanel c = MakeCard(422, 104);
            CardTitle(c, "签到状态");

            dotCheckin = new StatusDot();
            dotCheckin.DotColor = Theme.SubText;
            dotCheckin.Size = new Size(18, 18);
            dotCheckin.Location = new Point(20, 44);
            c.Controls.Add(dotCheckin);

            lblCheckin = new Label();
            lblCheckin.Text = "检测中…";
            lblCheckin.Font = Theme.F(15f, FontStyle.Bold);
            lblCheckin.ForeColor = Theme.SubText;
            lblCheckin.AutoSize = true;
            lblCheckin.Location = new Point(46, 38);
            c.Controls.Add(lblCheckin);

            lblMeta = AddText(c, "签到积分 —　额外积分 —　账号 —", 48, 72, 8.5f, Theme.SubText);

            lblCountdown = new Label();
            lblCountdown.Text = "";
            lblCountdown.Font = Theme.F(9f, FontStyle.Regular);
            lblCountdown.ForeColor = Theme.SubText;
            lblCountdown.AutoSize = false;
            lblCountdown.Size = new Size(290, 24);
            lblCountdown.TextAlign = ContentAlignment.MiddleRight;
            lblCountdown.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            lblCountdown.Location = new Point(564, 42);
            c.Controls.Add(lblCountdown);
        }

        private void BuildActCard()
        {
            CardPanel c = MakeCard(538, 74);
            btnCheckin = Btn(c, "立即签到并领奖", 18, 19, 158, 36, FlatButton.Kind.Primary);
            btnCheckin.Font = Theme.F(10f, FontStyle.Bold);
            btnCheckin.Click += delegate { Go("checkin"); };

            btnStatus = Btn(c, "刷新状态", 186, 19, 100, 36, FlatButton.Kind.Ghost);
            btnStatus.Click += delegate { Go("brief"); };

            btnToken = Btn(c, "刷新 Token", 294, 19, 110, 36, FlatButton.Kind.Ghost);
            btnToken.Click += delegate { Go("token"); };

            btnOpenLog = Btn(c, "打开日志", 412, 19, 100, 36, FlatButton.Kind.Ghost);
            btnOpenLog.Click += delegate { OpenFolder(AppPaths.LogDir); };

            btnClear = Btn(c, "清空日志", 520, 19, 100, 36, FlatButton.Kind.Ghost);
            btnClear.Click += delegate { txtLog.Clear(); };
        }

        private void BuildTimeCard()
        {
            CardPanel c = MakeCard(624, 100);
            CardTitle(c, "每日定时");

            chkEnable = new CheckBox();
            chkEnable.Text = "启用每日自动签到";
            chkEnable.Font = Theme.F(9.5f, FontStyle.Regular);
            chkEnable.ForeColor = Theme.Text;
            chkEnable.Location = new Point(18, 48);
            chkEnable.AutoSize = true;
            c.Controls.Add(chkEnable);

            AddText(c, "执行时间", 176, 50, 9f, Theme.SubText);

            dtpTime = new DateTimePicker();
            dtpTime.Format = DateTimePickerFormat.Custom;
            dtpTime.CustomFormat = "HH:mm";
            dtpTime.ShowUpDown = true;
            dtpTime.Location = new Point(238, 46);
            dtpTime.Size = new Size(76, 26);
            dtpTime.Font = Theme.F(9.5f, FontStyle.Regular);
            c.Controls.Add(dtpTime);

            btnSaveTime = Btn(c, "保存设置", 328, 44, 96, 32, FlatButton.Kind.Primary);
            btnSaveTime.Click += delegate { SaveSchedule(); };

            btnRunTask = Btn(c, "立即执行", 432, 44, 96, 32, FlatButton.Kind.Ghost);
            btnRunTask.Click += delegate { RunTaskNow(); };

            btnDeleteTask = Btn(c, "删除任务", 536, 44, 96, 32, FlatButton.Kind.Danger);
            btnDeleteTask.Click += delegate { DeleteSchedule(); };

            lblTask = AddText(c, "计划任务：检测中…", 18, 76, 8.5f, Theme.SubText);
        }

        private void BuildLogCard()
        {
            CardPanel c = new CardPanel();
            c.Location = new Point(14, 736);
            c.Size = new Size(872, 140);
            c.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom;
            Controls.Add(c);
            CardTitle(c, "运行日志");

            txtLog = new RichTextBox();
            txtLog.Location = new Point(18, 36);
            txtLog.Size = new Size(836, 90);
            txtLog.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom;
            txtLog.ReadOnly = true;
            txtLog.BackColor = Color.FromArgb(0xFB, 0xFC, 0xFE);
            txtLog.BorderStyle = BorderStyle.None;
            txtLog.Font = new Font("Consolas", 9f);
            txtLog.WordWrap = false;
            txtLog.DetectUrls = false;
            c.Controls.Add(txtLog);
        }
        // ================= 行为 =================

        private void OnLoaded()
        {
            try { CoreBundle.Extract(); }
            catch (Exception ex) { MessageBox.Show(this, ex.Message, "初始化失败", MessageBoxButtons.OK, MessageBoxIcon.Error); }

            string t = Config.Get("time", "07:02");
            try
            {
                string[] hm = t.Split(':');
                dtpTime.Value = new DateTime(2000, 1, 1, int.Parse(hm[0]), int.Parse(hm[1]), 0);
            }
            catch { dtpTime.Value = new DateTime(2000, 1, 1, 7, 2, 0); }
            chkEnable.Checked = Config.Get("enabled", "1") == "1";

            AppendLog("程序已启动 v" + Theme.Version + "，内核目录 " + AppPaths.CoreDir, 1);
            DetectEnvironment();
            RefreshTaskLabel();
            EnsureTask();
        }

        /** level: 0=普通 1=信息 2=成功 3=警告 4=错误 */
        private void AppendLog(string line, int level)
        {
            if (txtLog.TextLength > 200000) txtLog.Clear();
            Color c = Theme.Text;
            if (level == 1) c = Theme.SubText;
            else if (level == 2) c = Theme.Ok;
            else if (level == 3) c = Theme.Warn;
            else if (level == 4) c = Theme.Err;

            txtLog.SelectionStart = txtLog.TextLength;
            txtLog.SelectionLength = 0;
            txtLog.SelectionColor = Color.FromArgb(0x9A, 0xA1, 0xAC);
            string stamp = DateTime.Now.ToString("HH:mm:ss ");
            txtLog.AppendText(stamp);
            txtLog.SelectionStart = txtLog.TextLength;
            txtLog.SelectionColor = c;
            txtLog.AppendText(line + Environment.NewLine);
            txtLog.SelectionStart = txtLog.TextLength;
            txtLog.ScrollToCaret();
            try
            {
                File.AppendAllText(Path.Combine(AppPaths.LogDir, "gui.log"),
                    DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss ") + line + Environment.NewLine, Encoding.UTF8);
            }
            catch { }
        }

        private int GuessLevel(string line)
        {
            if (line == null) return 0;
            if (line.IndexOf("错误") >= 0 || line.IndexOf("失败") >= 0 || line.IndexOf("error", StringComparison.OrdinalIgnoreCase) >= 0) return 4;
            if (line.IndexOf("警告") >= 0 || line.IndexOf("9070") >= 0 || line.IndexOf("9090") >= 0) return 3;
            if (line.IndexOf("完成") >= 0 || line.IndexOf("成功") >= 0 || line.IndexOf("已签到") >= 0) return 2;
            return 0;
        }

        private void SetBusy(bool value, string text)
        {
            busy = value;
            progress.Visible = value;
            progress.Style = value ? ProgressBarStyle.Marquee : ProgressBarStyle.Blocks;
            if (text != null) statusLabel.Text = text;
            btnCheckin.Enabled = !value;
            btnStatus.Enabled = !value;
            btnToken.Enabled = !value;
            btnSaveTime.Enabled = !value;
        }

        private void DetectEnvironment()
        {
            SetBusy(true, "正在检测环境…");
            Task.Run(delegate
            {
                try
                {
                    CoreBundle.Extract();
                    Runner r = Runtime.ResolveRunner(traeHint);
                    if (r == null)
                    {
                        BeginInvoke(new Action(delegate
                        {
                            SetBusy(false, "未找到运行环境");
                            lblRunner.Text = "运行器：未找到 node.exe 或 Trae CN.exe，请点「浏览…」指定";
                            lblRunner.ForeColor = Theme.Err;
                            AppendLog("未找到 node.exe 或 Trae CN.exe，无法执行签到内核。", 4);
                        }));
                        return;
                    }
                    runner = r;
                    Runtime.BaseEnv.Clear();
                    if (!string.IsNullOrEmpty(traeHint)) Runtime.BaseEnv["TRAE_EXE"] = traeHint;
                    if (!string.IsNullOrEmpty(userDataHint)) Runtime.BaseEnv["TRAE_USERDATA"] = userDataHint;

                    string outp = Runtime.Capture(runner, "envkv", 90000);
                    Dictionary<string, string> kv = Runtime.ParseKv(outp);
                    BeginInvoke(new Action(delegate
                    {
                        ApplyEnv(kv);
                        SetBusy(false, "就绪");
                        RefreshStatus();
                    }));
                }
                catch (Exception ex)
                {
                    BeginInvoke(new Action(delegate
                    {
                        SetBusy(false, "检测失败");
                        AppendLog("环境检测失败：" + ex.Message, 4);
                    }));
                }
            });
        }

        private void ApplyEnv(Dictionary<string, string> kv)
        {
            string ud = Get(kv, "USER_DATA_DIR");
            string trae = Get(kv, "TRAE_EXE");
            bool readable = Get(kv, "READABLE") == "true";

            if (string.IsNullOrEmpty(userDataHint)) userDataHint = ud;
            txtData.Text = string.IsNullOrEmpty(ud) ? "（未检测到）" : ud;
            txtTrae.Text = string.IsNullOrEmpty(trae) ? "（未检测到）" : trae;
            if (string.IsNullOrEmpty(traeHint) && !string.IsNullOrEmpty(trae)) traeHint = trae;

            lblRunner.Text = "运行器：" + (runner == null ? "—" : runner.Display);
            lblRunner.ForeColor = Theme.SubText;

            if (readable) AppendLog("环境就绪，数据目录 " + ud, 2);
            else AppendLog("未能在该目录读到 Trae 登录凭据，请确认已在 Trae 中登录。", 3);
        }

        private string Get(Dictionary<string, string> kv, string key)
        {
            string v;
            return kv.TryGetValue(key, out v) ? v : "";
        }

        private void RefreshStatus()
        {
            if (runner == null) return;
            Task.Run(delegate
            {
                try
                {
                    string o = Runtime.Capture(runner, "brief", 90000);
                    Dictionary<string, string> kv = Runtime.ParseKv(o);
                    BeginInvoke(new Action(delegate { ApplyStatus(kv); }));
                    RefreshAccounts();
                }
                catch (Exception ex)
                {
                    BeginInvoke(new Action(delegate { AppendLog("刷新状态失败：" + ex.Message, 4); }));
                }
            });
        }

        private void ApplyStatus(Dictionary<string, string> kv)
        {
            if (kv.Count == 0) { lblCheckin.Text = "状态未知"; return; }

            string checkedIn = Get(kv, "CHECKED_IN");
            string enable = Get(kv, "ENABLE");
            string credits = Get(kv, "CREDITS");
            string extra = Get(kv, "EXTRA_CREDITS");
            string acc = Get(kv, "ACCOUNT");
            string uid = Get(kv, "USER_ID");

            if (checkedIn == "true")
            {
                lblCheckin.Text = "今日已签到";
                lblCheckin.ForeColor = Theme.Ok;
                dotCheckin.DotColor = Theme.Ok;
            }
            else if (enable == "true")
            {
                lblCheckin.Text = "今日未签到";
                lblCheckin.ForeColor = Theme.Warn;
                dotCheckin.DotColor = Theme.Warn;
            }
            else
            {
                lblCheckin.Text = "签到活动未开启";
                lblCheckin.ForeColor = Theme.SubText;
                dotCheckin.DotColor = Theme.SubText;
            }

            lblMeta.Text = "签到积分 " + (string.IsNullOrEmpty(credits) ? "—" : credits)
                + "　额外积分 " + (string.IsNullOrEmpty(extra) ? "—" : extra)
                + "　账号 " + (string.IsNullOrEmpty(acc) ? "未登录" : acc + "（" + uid + "）");

            lblAccount.Text = "账号：" + (string.IsNullOrEmpty(acc) ? "未登录" : acc);
            bool expired = Get(kv, "TOKEN_EXPIRED") == "true";
            lblToken.Text = "Token：" + (expired ? "已过期" : "有效") + "　到期 " + FormatTime(Get(kv, "TOKEN_EXP"));
            lblToken.ForeColor = expired ? Theme.Err : Theme.SubText;
        }

        private string FormatTime(string iso)
        {
            if (string.IsNullOrEmpty(iso)) return "—";
            DateTime dt;
            if (DateTime.TryParse(iso, out dt)) return dt.ToLocalTime().ToString("yyyy-MM-dd HH:mm");
            return iso;
        }
        private void UpdateCountdown()
        {
            if (nextRun == DateTime.MinValue || nextRun <= DateTime.Now)
            {
                lblCountdown.Text = nextRun == DateTime.MinValue ? "" : "下次自动签到：即将执行";
                return;
            }
            TimeSpan span = nextRun - DateTime.Now;
            string left;
            if (span.TotalHours >= 1) left = ((int)span.TotalHours) + " 小时 " + span.Minutes + " 分";
            else left = span.Minutes + " 分 " + span.Seconds + " 秒";
            lblCountdown.Text = "下次自动签到 " + nextRun.ToString("MM-dd HH:mm") + "　还有 " + left;
            lblCountdown.ForeColor = span.TotalMinutes < 30 ? Theme.Warn : Theme.SubText;
        }

        private void Go(string action)
        {
            if (busy) return;
            if (action == "brief")
            {
                AppendLog("──────── 刷新状态", 1);
                RefreshStatus();
                RefreshTaskLabel();
                return;
            }
            if (runner == null)
            {
                MessageBox.Show(this, "还没有可用的运行环境，请先点「重新检测」或手动指定 Trae CN.exe。", "提示");
                return;
            }
            string args;
            if (action == "checkin") args = "run --grants";
            else if (action == "import") args = "import";
            else if (action == "runall") args = "runall";
            else if (action == "token") args = "refresh";
            else args = "brief";

            SetBusy(true, action == "checkin" ? "正在签到…" : "执行中…");
            AppendLog("──────── 执行：" + args, 1);

            Task.Run(delegate
            {
                int code = Runtime.Run(runner, args, delegate(string line)
                {
                    int lv = GuessLevel(line);
                    BeginInvoke(new Action(delegate { AppendLog(line, lv); }));
                }, 240000);

                BeginInvoke(new Action(delegate
                {
                    SetBusy(false, code == 0 ? "完成" : "结束（代码 " + code + "）");
                    RefreshStatus();
                    RefreshAccounts();
                    RefreshTaskLabel();
                }));
            });
        }

        private void BrowseTrae()
        {
            OpenFileDialog dlg = new OpenFileDialog();
            dlg.Title = "选择 Trae CN.exe";
            dlg.Filter = "Trae 主程序 (*.exe)|*.exe";
            if (!string.IsNullOrEmpty(traeHint) && File.Exists(traeHint))
                dlg.InitialDirectory = Path.GetDirectoryName(traeHint);
            if (dlg.ShowDialog(this) == DialogResult.OK)
            {
                traeHint = dlg.FileName;
                Config.Set("trae_exe", traeHint);
                Config.Save();
                AppendLog("已指定 Trae 程序：" + traeHint, 2);
                DetectEnvironment();
            }
        }

        private void BrowseData()
        {
            FolderBrowserDialog dlg = new FolderBrowserDialog();
            dlg.Description = "选择 Trae 数据目录（含 User\\globalStorage\\storage.json 的目录）";
            if (!string.IsNullOrEmpty(userDataHint) && Directory.Exists(userDataHint))
                dlg.SelectedPath = userDataHint;
            if (dlg.ShowDialog(this) == DialogResult.OK)
            {
                string p = dlg.SelectedPath;
                string st = Path.Combine(p, "User", "globalStorage", "storage.json");
                if (!File.Exists(st) && !File.Exists(Path.Combine(p, "storage.json")))
                {
                    DialogResult r = MessageBox.Show(this,
                        "该目录下没找到 User\\globalStorage\\storage.json。\n\n通常应在：\n%APPDATA%\\Trae CN\n\n仍要使用这个目录吗？",
                        "目录可能不正确", MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
                    if (r != DialogResult.Yes) return;
                }
                userDataHint = p;
                Config.Set("user_data", userDataHint);
                Config.Save();
                AppendLog("已指定数据目录：" + userDataHint, 2);
                DetectEnvironment();
            }
        }
        private void SaveSchedule()
        {
            string hhmm = dtpTime.Value.ToString("HH:mm");
            Config.Set("time", hhmm);
            Config.Set("enabled", chkEnable.Checked ? "1" : "0");
            Config.Save();

            if (!chkEnable.Checked)
            {
                SetBusy(true, "正在删除计划任务…");
                Task.Run(delegate
                {
                    TaskSched.Delete();
                    BeginInvoke(new Action(delegate
                    {
                        SetBusy(false, "已关闭自动签到");
                        AppendLog("已关闭每日自动签到，计划任务已删除。", 3);
                        nextRun = DateTime.MinValue;
                        RefreshTaskLabel();
                    }));
                });
                return;
            }

            SetBusy(true, "正在写入计划任务…");
            Task.Run(delegate
            {
                string outp = TaskSched.Create(hhmm);
                BeginInvoke(new Action(delegate
                {
                    SetBusy(false, "已保存");
                    AppendLog("已设置每日 " + hhmm + " 自动签到。", 2);
                    if (!string.IsNullOrEmpty(outp)) AppendLog(outp, 3);
                    RefreshTaskLabel();
                }));
            });
        }

        private void DeleteSchedule()
        {
            if (MessageBox.Show(this, "确定要删除每日自动签到任务吗？", "确认",
                MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
            chkEnable.Checked = false;
            SaveSchedule();
        }

        private void RunTaskNow()
        {
            if (!TaskSched.Exists())
            {
                MessageBox.Show(this, "还没有创建计划任务，请先点「保存设置」。", "提示");
                return;
            }
            TaskSched.RunNow();
            AppendLog("已触发计划任务后台执行（静默模式）。", 1);
            SetBusy(true, "任务已触发…");
            Timer tm = new Timer();
            tm.Interval = 3000;
            tm.Tick += delegate
            {
                tm.Stop();
                tm.Dispose();
                SetBusy(false, "就绪");
                RefreshTaskLabel();
                RefreshStatus();
            };
            tm.Start();
        }

        private void EnsureTask()
        {
            Task.Run(delegate
            {
                try
                {
                    if (Config.Get("enabled", "1") != "1") return;
                    Dictionary<string, string> info = TaskSched.Query();
                    string ev, ex;
                    info.TryGetValue("EXISTS", out ev);
                    info.TryGetValue("EXEC", out ex);
                    string reason = null;
                    if (ev != "1") reason = "未发现计划任务，已自动创建";
                    else if (!string.Equals(ex, AppPaths.ExePath, StringComparison.OrdinalIgnoreCase))
                        reason = "计划任务指向旧路径，已自动更新为当前程序";
                    if (reason == null) return;
                    string tm = Config.Get("time", "07:02");
                    TaskSched.Create(tm);
                    BeginInvoke(new Action(delegate
                    {
                        AppendLog(reason + "（每日 " + tm + "）", 2);
                        RefreshTaskLabel();
                    }));
                }
                catch { }
            });
        }

        private void RefreshTaskLabel()
        {
            Task.Run(delegate
            {
                Dictionary<string, string> info = TaskSched.Query();
                string ev, next, last;
                info.TryGetValue("EXISTS", out ev);
                info.TryGetValue("NEXT", out next);
                info.TryGetValue("LAST", out last);
                bool exists = ev == "1";
                if (next == null) next = "";
                if (last == null) last = "";
                if (last == "267011") last = "尚未运行";
                DateTime parsed = DateTime.MinValue;
                if (!string.IsNullOrEmpty(next)) DateTime.TryParse(next, out parsed);

                BeginInvoke(new Action(delegate
                {
                    if (exists)
                    {
                        lblTask.Text = "计划任务：已启用　下次执行 " + (string.IsNullOrEmpty(next) ? "—" : next)
                            + (string.IsNullOrEmpty(last) ? "" : "　上次结果 " + last);
                        lblTask.ForeColor = Theme.Ok;
                        nextRun = parsed;
                    }
                    else
                    {
                        lblTask.Text = "计划任务：未创建（设置时间后点「保存设置」）";
                        lblTask.ForeColor = Theme.SubText;
                        nextRun = DateTime.MinValue;
                    }
                    UpdateCountdown();
                }));
            });
        }

        private void OpenFolder(string path)
        {
            try
            {
                Directory.CreateDirectory(path);
                Process.Start("explorer.exe", "\"" + path + "\"");
            }
            catch (Exception ex) { AppendLog("打开目录失败：" + ex.Message, 4); }
        }

        private void CopyContact()
        {
            try
            {
                Clipboard.SetText(Theme.Contact);
                statusLabel.Text = "已复制联系方式 " + Theme.Contact;
            }
            catch { }
        }

        private void ShowDisclaimer()
        {
            using (DisclaimerForm f = new DisclaimerForm())
            {
                f.ShowDialog(this);
                if (f.Agreed && f.DontShowAgain)
                {
                    Config.Set("disclaimer_accepted", "1");
                    Config.Save();
                }
            }
        }
    }
}