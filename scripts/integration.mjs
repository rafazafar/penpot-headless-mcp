import { spawn } from "node:child_process";
import { setTimeout } from "node:timers/promises";

const compose = ["compose", "-p", "penpot-headless-mcp-test", "-f", "test/integration/compose.yaml"];
function run(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
  });
}

try {
  await run("docker", [...compose, "up", "-d", "--wait", "--wait-timeout", "120"]);
  const deadline = Date.now() + 120_000;
  while (true) {
    try {
      const response = await fetch("http://127.0.0.1:19061/readyz", { signal: AbortSignal.timeout(2000) });
      if (response.ok) break;
    } catch { /* The JVM may still be starting. */ }
    if (Date.now() >= deadline) throw new Error("Penpot backend did not become ready within 120 seconds.");
    await setTimeout(1000);
  }
  await run(process.execPath, ["--import", "tsx", "--test", "test/integration/backend.test.ts"], {
    ...process.env, PENPOT_TEST_URL: "http://127.0.0.1:19061",
  });
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
} finally {
  // This project owns only the disposable integration stack; no user Penpot service is touched.
  await run("docker", [...compose, "down", "--volumes"]).catch(error => {
    process.stderr.write(`${error.message}\n`); process.exitCode = 1;
  });
}
