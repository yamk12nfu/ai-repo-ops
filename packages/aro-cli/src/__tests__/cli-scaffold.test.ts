import { describe, expect, it } from "vitest";

import { ARO_CLI_VERSION, buildProgram } from "../main.js";

describe("aro CLI scaffold", () => {
  it("トップレベルコマンドを登録している", () => {
    const program = buildProgram();
    const names = program.commands.map((command) => command.name()).sort();
    expect(names).toEqual(["diff", "doctor", "guard", "init", "knowledge", "sync"]);
  });

  it("--help に各コマンドと概要を含む", () => {
    const help = buildProgram().helpInformation();
    expect(help).toContain("init");
    expect(help).toContain("diff");
    expect(help).toContain("sync");
    expect(help).toContain("doctor");
    expect(help).toContain("guard");
    expect(help).toContain("knowledge");
    expect(help).toContain("aro");
  });

  it("CLIバージョンを公開している", () => {
    expect(buildProgram().version()).toBe(ARO_CLI_VERSION);
    expect(ARO_CLI_VERSION).toBe("0.2.0");
  });

  it("diff は --detailed-exitcode オプションを持つ", () => {
    const diff = buildProgram().commands.find((command) => command.name() === "diff");
    expect(diff).toBeDefined();
    const help = diff?.helpInformation() ?? "";
    expect(help).toContain("--detailed-exitcode");
  });

  it("guard は必須の --base オプションを持つ", () => {
    const guard = buildProgram().commands.find((command) => command.name() === "guard");
    expect(guard).toBeDefined();
    const help = guard?.helpInformation() ?? "";
    expect(help).toContain("--base <ref>");
  });

  it("knowledge は init / check サブコマンドを持つ", () => {
    const knowledge = buildProgram().commands.find((command) => command.name() === "knowledge");
    expect(knowledge).toBeDefined();
    expect(knowledge?.commands.map((command) => command.name()).sort()).toEqual(["check", "init"]);

    const initHelp = knowledge?.commands.find((command) => command.name() === "init")?.helpInformation() ?? "";
    const checkHelp = knowledge?.commands.find((command) => command.name() === "check")?.helpInformation() ?? "";
    expect(initHelp).toContain("--dry-run");
    expect(initHelp).toContain("--json");
    expect(initHelp).toContain("--base <ref>");
    const baseOption = knowledge?.commands
      .find((command) => command.name() === "init")
      ?.options.find((option) => option.long === "--base");
    expect(baseOption?.mandatory).toBe(true);
    expect(checkHelp).toContain("--strict");
    expect(checkHelp).toContain("--json");
  });
});
