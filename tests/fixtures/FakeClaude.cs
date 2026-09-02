using System;
using System.IO;
using System.Diagnostics;
using System.Threading;

namespace FakeClaude
{
    class Program
    {
        static int Main(string[] args)
        {
            string tempDir = Path.GetTempPath();
            string logFile = Path.Combine(tempDir, "fake-claude-executions.jsonl");
            string scenarioFile = Path.Combine(tempDir, "fake-claude-scenario.json");

            int pid = Process.GetCurrentProcess().Id;
            string cwd = Environment.CurrentDirectory;

            // Log execution
            try
            {
                string logLine = string.Format(
                    "{{\"pid\":{0},\"cwd\":\"{1}\",\"time\":\"{2}\",\"args\":[{3}]}}\n",
                    pid,
                    cwd.Replace("\\", "\\\\"),
                    DateTime.UtcNow.ToString("o"),
                    string.Join(",", Array.ConvertAll(args, a => "\"" + a.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\""))
                );
                File.AppendAllText(logFile, logLine);
            }
            catch { }

            // Check scenario
            string scenario = "success";
            int exitCode = 0;
            int delayMs = 0;
            string stdoutText = "Specialist execution finished successfully.\n";
            string stderrText = "";
            bool overflow = false;
            string modifyFileName = null;
            string modifyFileContent = null;
            bool spawnChild = false;

            if (File.Exists(scenarioFile))
            {
                try
                {
                    string content = File.ReadAllText(scenarioFile);
                    if (content.Contains("\"scenario\":\"nonzero\""))
                    {
                        scenario = "nonzero";
                        exitCode = 42;
                        stderrText = "Specialist encountered non-zero exit error.\n";
                    }
                    else if (content.Contains("\"scenario\":\"timeout\"") || content.Contains("\"scenario\":\"hang\""))
                    {
                        scenario = "hang";
                    }
                    else if (content.Contains("\"scenario\":\"delayed\""))
                    {
                        scenario = "delayed";
                        delayMs = 1500;
                    }
                    else if (content.Contains("\"scenario\":\"barrier\""))
                    {
                        scenario = "barrier";
                    }
                    else if (content.Contains("\"scenario\":\"overflow\""))
                    {
                        scenario = "overflow";
                        overflow = true;
                    }
                    else if (content.Contains("\"scenario\":\"empty\""))
                    {
                        scenario = "empty";
                        stdoutText = "";
                    }
                    else if (content.Contains("\"scenario\":\"malformed\""))
                    {
                        scenario = "malformed";
                        stdoutText = "{not valid json\0\0";
                    }
                    else if (content.Contains("\"scenario\":\"child_process\""))
                    {
                        spawnChild = true;
                    }

                    if (content.Contains("\"exitCode\":"))
                    {
                        int idx = content.IndexOf("\"exitCode\":") + 11;
                        int end = content.IndexOfAny(new char[] { ',', '}', '\r', '\n' }, idx);
                        if (end > idx) int.TryParse(content.Substring(idx, end - idx).Trim(), out exitCode);
                    }

                    if (content.Contains("\"delayMs\":"))
                    {
                        int idx = content.IndexOf("\"delayMs\":") + 10;
                        int end = content.IndexOfAny(new char[] { ',', '}', '\r', '\n' }, idx);
                        if (end > idx) int.TryParse(content.Substring(idx, end - idx).Trim(), out delayMs);
                    }

                    if (content.Contains("\"stdout\":"))
                    {
                        int idx = content.IndexOf("\"stdout\":\"") + 10;
                        int end = content.IndexOf("\"", idx);
                        if (end > idx) stdoutText = content.Substring(idx, end - idx);
                    }

                    if (content.Contains("\"stderr\":"))
                    {
                        int idx = content.IndexOf("\"stderr\":\"") + 10;
                        int end = content.IndexOf("\"", idx);
                        if (end > idx) stderrText = content.Substring(idx, end - idx);
                    }

                    if (content.Contains("\"modifyFileName\":"))
                    {
                        int idx = content.IndexOf("\"modifyFileName\":\"") + 18;
                        int end = content.IndexOf("\"", idx);
                        if (end > idx) modifyFileName = content.Substring(idx, end - idx);
                    }
                    else if (content.Contains("\"modifyFile\":true"))
                    {
                        modifyFileName = "specialist-result.txt";
                        modifyFileContent = "Modified by specialist.\n";
                    }

                    if (content.Contains("\"modifyFileContent\":"))
                    {
                        int idx = content.IndexOf("\"modifyFileContent\":\"") + 21;
                        int end = content.IndexOf("\"", idx);
                        if (end > idx) modifyFileContent = content.Substring(idx, end - idx);
                    }

                    if (content.Contains("\"attemptForbidden\":true"))
                    {
                        try
                        {
                            File.WriteAllText(Path.Combine(cwd, "..", "forbidden-leak.txt"), "forbidden");
                        }
                        catch { }
                    }
                }
                catch { }
            }

            if (scenario == "hang")
            {
                Thread.Sleep(Timeout.Infinite);
                return 0;
            }

            if (scenario == "barrier")
            {
                string readyFile = Path.Combine(tempDir, "fake-claude-ready.txt");
                string releaseFile = Path.Combine(tempDir, "fake-claude-release.txt");
                try { File.WriteAllText(readyFile, "ready\n"); } catch { }
                int waited = 0;
                while (!File.Exists(releaseFile) && waited < 15000)
                {
                    Thread.Sleep(20);
                    waited += 20;
                }
            }

            if (delayMs > 0)
            {
                Thread.Sleep(delayMs);
            }

            if (spawnChild)
            {
                try
                {
                    Process.Start(new ProcessStartInfo
                    {
                        FileName = "cmd.exe",
                        Arguments = "/c ping -n 10 127.0.0.1 > nul",
                        CreateNoWindow = true,
                        UseShellExecute = false
                    });
                }
                catch { }
            }

            if (modifyFileName != null)
            {
                try
                {
                    File.WriteAllText(Path.Combine(cwd, modifyFileName), modifyFileContent ?? "change");
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine("Failed to modify file: " + ex.Message);
                }
            }

            if (overflow)
            {
                byte[] chunk = new byte[64 * 1024];
                for (int i = 0; i < chunk.Length; i++) chunk[i] = (byte)'A';
                for (int i = 0; i < 40; i++) // > 2.5 MB
                {
                    Console.OpenStandardOutput().Write(chunk, 0, chunk.Length);
                }
                return 0;
            }

            // Read prompt from stdin (supervisor writes prompt after identity inspection)
            string prompt = "";
            try
            {
                prompt = Console.In.ReadToEnd();
            }
            catch { }

            if (!string.IsNullOrEmpty(stderrText))
            {
                Console.Error.Write(stderrText);
            }

            if (!string.IsNullOrEmpty(stdoutText))
            {
                Console.Out.Write(stdoutText);
            }

            return exitCode;
        }
    }
}
