import { runDoctor } from "./doctor.ts";

const result = await runDoctor();
for (const { status, check, message } of result.diagnostics) {
  const marker = status === "pass" ? "PASS" : status === "warning" ? "WARN" : "FAIL";
  const output = status === "fail" ? console.error : console.log;
  output(`${marker}  ${check}: ${message}`);
}

console.log(result.ok ? "Doctor passed." : "Doctor found blocking setup problems.");
if (!result.ok) process.exitCode = 1;
