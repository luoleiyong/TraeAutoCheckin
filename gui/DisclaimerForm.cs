using System;
using System.Drawing;
using System.Windows.Forms;

namespace TraeAutoCheckin
{
    /** 启动声明页：禁止商用 / 仅限个人使用 */
    internal class DisclaimerForm : Form
    {
        private CheckBox chkDontShow;
        private FlatButton btnOk;
        private FlatButton btnExit;
        public bool Agreed { get; private set; }
        public bool DontShowAgain { get { return chkDontShow.Checked; } }

        private static readonly string Body =
            "一、使用范围\n" +
            "    本软件为作者个人编写的辅助工具，仅限个人学习、研究与自用。\n" +
            "    严禁用于任何商业用途，包括但不限于：售卖、租赁、代签到收费、\n" +
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
            "    若你不同意上述任何一条，请立即关闭本程序并删除全部文件。\n" +
            "    继续使用即视为你已完整阅读并接受上述条款。";

        public DisclaimerForm()
        {
            Text = "使用声明";
            ClientSize = new Size(620, 700);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Theme.Card;
            Font = Theme.F(9f, FontStyle.Regular);
            try { Icon = Theme.BuildIcon(); } catch { }

            Panel head = new Panel();
            head.Dock = DockStyle.Top;
            head.Height = 64;
            head.BackColor = Theme.Card;
            Controls.Add(head);

            StatusDot dot = new StatusDot();
            dot.DotColor = Theme.Primary;
            dot.Size = new Size(20, 20);
            dot.Location = new Point(22, 22);
            head.Controls.Add(dot);

            Label t = new Label();
            t.Text = "使用声明";
            t.Font = Theme.F(15f, FontStyle.Bold);
            t.ForeColor = Theme.Text;
            t.AutoSize = true;
            t.Location = new Point(48, 17);
            head.Controls.Add(t);

            Label sv = new Label();
            sv.Text = "禁止商用 · 仅限个人使用";
            sv.Font = Theme.F(9f, FontStyle.Regular);
            sv.ForeColor = Theme.Warn;
            sv.AutoSize = true;
            sv.Location = new Point(50, 42);
            head.Controls.Add(sv);

            Label body = new Label();
            body.Text = Body;
            body.Font = Theme.F(9.5f, FontStyle.Regular);
            body.ForeColor = Color.FromArgb(0x37, 0x3D, 0x47);
            body.Location = new Point(24, 74);
            body.Size = new Size(572, 500);
            body.AutoSize = false;
            body.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom;
            Controls.Add(body);

            Panel foot = new Panel();
            foot.Dock = DockStyle.Bottom;
            foot.Height = 108;
            foot.BackColor = Color.FromArgb(0xFA, 0xFB, 0xFD);
            Controls.Add(foot);

            chkDontShow = new CheckBox();
            chkDontShow.Text = "我已阅读并同意上述条款，下次不再提示";
            chkDontShow.Font = Theme.F(9.5f, FontStyle.Regular);
            chkDontShow.ForeColor = Theme.Text;
            chkDontShow.AutoSize = true;
            chkDontShow.Location = new Point(26, 16);
            chkDontShow.Checked = true;
            foot.Controls.Add(chkDontShow);

            Label mail = new Label();
            mail.Text = "联系方式：" + Theme.Contact;
            mail.Font = Theme.F(9.5f, FontStyle.Regular);
            mail.ForeColor = Theme.Primary;
            mail.AutoSize = true;
            mail.Location = new Point(26, 50);
            mail.Cursor = Cursors.Hand;
            mail.Click += delegate { try { Clipboard.SetText(Theme.Contact); } catch { } };
            foot.Controls.Add(mail);

            Label tipCopy = new Label();
            tipCopy.Text = "（点击邮箱可复制）";
            tipCopy.Font = Theme.F(8.5f, FontStyle.Regular);
            tipCopy.ForeColor = Theme.SubText;
            tipCopy.AutoSize = true;
            tipCopy.Location = new Point(215, 52);
            foot.Controls.Add(tipCopy);

            btnExit = new FlatButton();
            btnExit.Text = "不同意，退出";
            btnExit.ButtonKind = FlatButton.Kind.Danger;
            btnExit.Size = new Size(110, 32);
            btnExit.Location = new Point(380, 62);
            btnExit.Click += delegate { DialogResult = DialogResult.Cancel; Close(); };
            foot.Controls.Add(btnExit);

            btnOk = new FlatButton();
            btnOk.Text = "同意并继续";
            btnOk.ButtonKind = FlatButton.Kind.Primary;
            btnOk.Size = new Size(120, 32);
            btnOk.Location = new Point(498, 62);
            btnOk.Click += delegate { Agreed = true; DialogResult = DialogResult.OK; Close(); };
            foot.Controls.Add(btnOk);

            AcceptButton = null;
            CancelButton = null;
        }
    }
}