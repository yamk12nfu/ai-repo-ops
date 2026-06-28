import { describe, expect, it } from "vitest";

import { ARO_CLI_VERSION, buildProgram } from "../main.js";

describe("aro CLI scaffold", () => {
  it("MVPの4サブコマンドを登録している", () => {
    const program = buildProgram();
    const names = program.commands.map((command) => command.name()).sort();
    expect(names).toEqual(["diff", "doctor", "init", "sync"]);
  });

  it("--help に各コマンドと概要を含む", () => {
    const help = buildProgram().helpInformation();
    expect(help).toContain("init");
    expect(help).toContain("diff");
    expect(help).toContain("sync");
    expect(help).toContain("doctor");
    expect(help).toContain("aro");
  });

  it("CLIバージョンを公開している", () => {
    expect(buildProgram().version()).toBe(ARO_CLI_VERSION);
    expect(ARO_CLI_VERSION).toBe("0.1.0");
  });

  it("diff は --detailed-exitcode オプションを持つ", () => {
    const diff = buildProgram().commands.find((command) => command.name() === "diff");
    expect(diff).toBeDefined();
    const help = diff?.helpInformation() ?? "";
    expect(help).toContain("--detailed-exitcode");
  });
});
