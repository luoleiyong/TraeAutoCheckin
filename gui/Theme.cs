using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace TraeAutoCheckin
{
    internal static class Theme
    {
        public static readonly Color Bg = Color.FromArgb(0xF5, 0xF6, 0xF8);
        public static readonly Color Card = Color.White;
        public static readonly Color Border = Color.FromArgb(0xE5, 0xE7, 0xEB);
        public static readonly Color Primary = Color.FromArgb(0x2F, 0x6B, 0xFF);
        public static readonly Color PrimaryHover = Color.FromArgb(0x1F, 0x5A, 0xEE);
        public static readonly Color PrimaryDown = Color.FromArgb(0x17, 0x4B, 0xD0);
        public static readonly Color Text = Color.FromArgb(0x1F, 0x23, 0x29);
        public static readonly Color SubText = Color.FromArgb(0x6B, 0x72, 0x80);
        public static readonly Color Ok = Color.FromArgb(0x16, 0xA3, 0x4A);
        public static readonly Color Warn = Color.FromArgb(0xD9, 0x77, 0x06);
        public static readonly Color Err = Color.FromArgb(0xDC, 0x26, 0x26);

        public const string Contact = "3270423617@qq.com";
        public const string AppTitle = "Trae 自动签到助手";
        public const string Version = "2.0";

        public static Font F(float size, FontStyle style)
        {
            return new Font("Microsoft YaHei UI", size, style, GraphicsUnit.Point);
        }

        public static GraphicsPath RoundRect(Rectangle r, int radius)
        {
            GraphicsPath p = new GraphicsPath();
            int d = radius * 2;
            if (d <= 0 || r.Width <= 0 || r.Height <= 0) { p.AddRectangle(r); return p; }
            p.AddArc(r.X, r.Y, d, d, 180, 90);
            p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            p.CloseFigure();
            return p;
        }

        public static Icon BuildIcon()
        {
            Bitmap bmp = new Bitmap(32, 32);
            using (Graphics g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.Clear(Color.Transparent);
                using (SolidBrush b = new SolidBrush(Primary)) g.FillEllipse(b, 1, 1, 30, 30);
                using (Pen pen = new Pen(Color.White, 3.2f))
                {
                    pen.StartCap = LineCap.Round;
                    pen.EndCap = LineCap.Round;
                    pen.LineJoin = LineJoin.Round;
                    g.DrawLines(pen, new PointF[] { new PointF(9, 17), new PointF(14, 22), new PointF(23, 11) });
                }
            }
            IntPtr h = bmp.GetHicon();
            Icon ic = (Icon)Icon.FromHandle(h).Clone();
            DestroyIcon(h);
            bmp.Dispose();
            return ic;
        }

        [DllImport("user32.dll")]
        private static extern bool DestroyIcon(IntPtr hIcon);
    }

    /** 白色圆角卡片 */
    internal class CardPanel : Panel
    {
        public CardPanel()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer
                | ControlStyles.UserPaint | ControlStyles.ResizeRedraw, true);
            BackColor = Theme.Card;
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            Rectangle r = new Rectangle(0, 0, Width - 1, Height - 1);
            using (GraphicsPath p = Theme.RoundRect(r, 10))
            {
                using (SolidBrush b = new SolidBrush(Theme.Card)) e.Graphics.FillPath(b, p);
                using (Pen pen = new Pen(Theme.Border)) e.Graphics.DrawPath(pen, p);
            }
        }
    }

    /** 顶部白色标题栏（底部分隔线） */
    internal class HeaderPanel : Panel
    {
        public HeaderPanel()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer
                | ControlStyles.UserPaint | ControlStyles.ResizeRedraw, true);
            BackColor = Theme.Card;
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            using (Pen pen = new Pen(Theme.Border)) e.Graphics.DrawLine(pen, 0, Height - 1, Width, Height - 1);
        }
    }

    /** 圆角扁平按钮（自绘，带 hover/pressed 态） */
    internal class FlatButton : Control
    {
        public enum Kind { Primary, Ghost, Danger }

        private bool hover;
        private bool down;
        private bool focusRing;
        private Kind kind = Kind.Ghost;

        public Kind ButtonKind
        {
            get { return kind; }
            set { kind = value; Invalidate(); }
        }

        public FlatButton()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer
                | ControlStyles.UserPaint | ControlStyles.ResizeRedraw
                | ControlStyles.SupportsTransparentBackColor, true);
            Font = Theme.F(9.5f, FontStyle.Regular);
            Cursor = Cursors.Hand;
            BackColor = Color.Transparent;
            Size = new Size(100, 32);
            TabStop = true;
        }

        protected override void OnMouseEnter(EventArgs e) { hover = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { hover = false; down = false; Invalidate(); base.OnMouseLeave(e); }
        protected override void OnMouseDown(MouseEventArgs e) { if (e.Button == MouseButtons.Left) { down = true; Invalidate(); } base.OnMouseDown(e); }
        protected override void OnMouseUp(MouseEventArgs e) { down = false; Invalidate(); base.OnMouseUp(e); }
        protected override void OnEnabledChanged(EventArgs e) { Invalidate(); base.OnEnabledChanged(e); }
        protected override void OnTextChanged(EventArgs e) { Invalidate(); base.OnTextChanged(e); }

        protected override bool IsInputKey(Keys keyData)
        {
            if (keyData == Keys.Space || keyData == Keys.Enter) return true;
            return base.IsInputKey(keyData);
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Space || e.KeyCode == Keys.Enter)
            {
                OnClick(EventArgs.Empty);
                e.Handled = true;
                e.SuppressKeyPress = true;
            }
            base.OnKeyDown(e);
        }

        protected override void OnGotFocus(EventArgs e) { focusRing = true; Invalidate(); base.OnGotFocus(e); }
        protected override void OnLostFocus(EventArgs e) { focusRing = false; Invalidate(); base.OnLostFocus(e); }

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            Color fill, text, border;
            if (kind == Kind.Primary)
            {
                fill = !Enabled ? Color.FromArgb(0xC9, 0xD8, 0xF8) : (down ? Theme.PrimaryDown : (hover ? Theme.PrimaryHover : Theme.Primary));
                text = Color.White;
                border = fill;
            }
            else if (kind == Kind.Danger)
            {
                fill = !Enabled ? Color.FromArgb(0xF3, 0xF4, 0xF6)
                     : (down ? Color.FromArgb(0xB9, 0x1C, 0x1C) : (hover ? Color.FromArgb(0xE5, 0x35, 0x35) : Color.White));
                text = !Enabled ? Color.Gray : (hover || down ? Color.White : Theme.Err);
                border = Enabled ? Color.FromArgb(0xFE, 0xCA, 0xCA) : Theme.Border;
            }
            else
            {
                fill = !Enabled ? Color.FromArgb(0xF3, 0xF4, 0xF6)
                     : (down ? Color.FromArgb(0xE2, 0xE6, 0xEE) : (hover ? Color.FromArgb(0xF0, 0xF3, 0xF8) : Color.White));
                text = Enabled ? Theme.Text : Color.Gray;
                border = Theme.Border;
            }

            Rectangle r = new Rectangle(0, 0, Width - 1, Height - 1);
            using (GraphicsPath p = Theme.RoundRect(r, 8))
            {
                using (SolidBrush b = new SolidBrush(fill)) e.Graphics.FillPath(b, p);
                using (Pen pen = new Pen(border)) e.Graphics.DrawPath(pen, p);
            }
            if (focusRing) { using (Pen fp = new Pen(Theme.Primary)) { fp.DashStyle = DashStyle.Dot; e.Graphics.DrawPath(fp, Theme.RoundRect(new Rectangle(2, 2, Width - 5, Height - 5), 7)); } }
            TextRenderer.DrawText(e.Graphics, Text, Font, r, text,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
        }
    }

    /** 圆形状态灯 */
    internal class StatusDot : Control
    {
        private Color dotColor = Theme.SubText;

        public Color DotColor
        {
            get { return dotColor; }
            set { dotColor = value; Invalidate(); }
        }

        public StatusDot()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer
                | ControlStyles.UserPaint | ControlStyles.ResizeRedraw
                | ControlStyles.SupportsTransparentBackColor, true);
            BackColor = Color.Transparent;
            Size = new Size(14, 14);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (SolidBrush halo = new SolidBrush(Color.FromArgb(48, dotColor))) e.Graphics.FillEllipse(halo, 0, 0, Width - 1, Height - 1);
            using (SolidBrush b = new SolidBrush(dotColor)) e.Graphics.FillEllipse(b, 3, 3, Width - 7, Height - 7);
        }
    }
}