using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace SathosaMotors.SafetyInspectionAdmin {
    static class Program {
        [STAThread]
        static void Main() {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new MainWindow());
        }
    }

    public class MainWindow : Form {
        private WebView2 webView;
        private Label lblStatus;
        private Panel loadingPanel;
        private Process backendProcess;
        private int appPort = 8082;
        private string appDir;

        public MainWindow() {
            appDir = AppDomain.CurrentDomain.BaseDirectory;
            ReadPortFromEnv();

            // Form properties
            this.Text = "Sathosa Motors - Safety Inspection Admin Panel";
            this.Size = new Size(1300, 860);
            this.MinimumSize = new Size(1024, 680);
            this.StartPosition = FormStartPosition.CenterScreen;
            this.BackColor = Color.FromArgb(15, 23, 42); // Match dark theme slate-900

            // Set Icon
            string icoPath = Path.Combine(appDir, "app.ico");
            if (File.Exists(icoPath)) {
                try {
                    this.Icon = new Icon(icoPath);
                } catch {}
            }

            // Create Loading Panel
            loadingPanel = new Panel();
            loadingPanel.Dock = DockStyle.Fill;
            loadingPanel.BackColor = Color.FromArgb(15, 23, 42);

            lblStatus = new Label();
            lblStatus.Text = "Starting Safety Inspection Admin Panel...";
            lblStatus.ForeColor = Color.FromArgb(226, 232, 240);
            lblStatus.Font = new Font("Segoe UI", 12f, FontStyle.Regular);
            lblStatus.AutoSize = false;
            lblStatus.TextAlign = ContentAlignment.MiddleCenter;
            lblStatus.Dock = DockStyle.Fill;
            loadingPanel.Controls.Add(lblStatus);
            this.Controls.Add(loadingPanel);

            // Create WebView2
            webView = new WebView2();
            webView.Dock = DockStyle.Fill;
            webView.Visible = false;
            this.Controls.Add(webView);

            // Events
            this.Load += MainWindow_Load;
            this.FormClosing += MainWindow_FormClosing;
        }

        private void ReadPortFromEnv() {
            try {
                string envPath = Path.Combine(appDir, ".env");
                if (File.Exists(envPath)) {
                    string[] lines = File.ReadAllLines(envPath);
                    foreach (string line in lines) {
                        string trimmed = line.Trim();
                        if (trimmed.StartsWith("PORT=", StringComparison.OrdinalIgnoreCase)) {
                            string pVal = trimmed.Substring(5).Trim();
                            int parsed;
                            if (int.TryParse(pVal, out parsed) && parsed > 0) {
                                appPort = parsed;
                            }
                        }
                    }
                }
            } catch {}
        }

        private async void MainWindow_Load(object sender, EventArgs e) {
            try {
                // 1. Ensure any dead or leftover process on this port is cleared
                KillExistingBackendOnPort();

                // 2. Start the backend process silently
                StartBackend();

                // 3. Wait for backend server to respond
                lblStatus.Text = "Connecting to Safety Inspection service...";
                bool ready = await WaitForServerAsync(TimeSpan.FromSeconds(15));
                if (!ready) {
                    lblStatus.Text = "Error: Inspection service failed to start.\nPlease verify your .env configuration.";
                    MessageBox.Show(
                        "Failed to connect to the Safety Inspection backend on port " + appPort + ".\n\n" +
                        "Please check that the port is not blocked and your .env configuration is valid.",
                        "Startup Error",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Error
                    );
                    return;
                }

                // 4. Initialize WebView2 with dedicated local data folder
                lblStatus.Text = "Loading interface...";
                string dataFolder = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "SathosaMotors",
                    "SafetyAdminWebViewData"
                );
                Directory.CreateDirectory(dataFolder);

                CoreWebView2Environment env = await CoreWebView2Environment.CreateAsync(null, dataFolder);
                await webView.EnsureCoreWebView2Async(env);

                // Configure WebView settings
                webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
                webView.CoreWebView2.Settings.AreDevToolsEnabled = false;

                // Navigate to the local server
                string appUrl = "http://localhost:" + appPort;
                webView.Source = new Uri(appUrl);

                // Show WebView when navigation starts
                webView.Visible = true;
                loadingPanel.Visible = false;
            } catch (Exception ex) {
                MessageBox.Show(
                    "Error initializing application:\n" + ex.Message,
                    "Application Error",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
            }
        }

        private void StartBackend() {
            string backendExe = Path.Combine(appDir, "SafetyAdminBackend.exe");
            if (!File.Exists(backendExe)) {
                // Try fallback to dist or node
                backendExe = Path.Combine(appDir, "backend", "SafetyAdminBackend.exe");
            }

            if (!File.Exists(backendExe)) {
                throw new FileNotFoundException("Backend executable not found: " + backendExe);
            }

            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = backendExe;
            psi.WorkingDirectory = appDir;
            psi.CreateNoWindow = true;
            psi.UseShellExecute = false;
            psi.WindowStyle = ProcessWindowStyle.Hidden;
            psi.EnvironmentVariables["AUTO_OPEN"] = "false";
            psi.EnvironmentVariables["PORT"] = appPort.ToString();

            backendProcess = Process.Start(psi);
        }

        private async Task<bool> WaitForServerAsync(TimeSpan timeout) {
            DateTime start = DateTime.Now;
            string url = "http://localhost:" + appPort + "/api/session";
            while (DateTime.Now - start < timeout) {
                try {
                    HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
                    request.Timeout = 1000;
                    request.Method = "GET";
                    using (HttpWebResponse response = (HttpWebResponse)await request.GetResponseAsync()) {
                        if (response.StatusCode == HttpStatusCode.OK || response.StatusCode == HttpStatusCode.Unauthorized) {
                            return true;
                        }
                    }
                } catch {
                    // Server not ready yet
                }
                await Task.Delay(300);
            }
            return false;
        }

        private void KillExistingBackendOnPort() {
            try {
                Process[] procs = Process.GetProcessesByName("SafetyAdminBackend");
                foreach (Process p in procs) {
                    try {
                        p.Kill();
                    } catch {}
                }
            } catch {}
        }

        private void MainWindow_FormClosing(object sender, FormClosingEventArgs e) {
            try {
                if (backendProcess != null && !backendProcess.HasExited) {
                    backendProcess.Kill();
                }
            } catch {}

            KillExistingBackendOnPort();
        }
    }
}
