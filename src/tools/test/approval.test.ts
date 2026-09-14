import { describe, expect, it } from "vitest";
import { evaluateCommand } from "../approval.ts";

describe("命令审批判定", () => {
  it("普通开发命令直接放行", () => {
    for (const command of ["ls -a", "pnpm test", "git status", "git diff", "git add .", "git commit -m 修复", "cat src/index.ts"]) {
      expect(evaluateCommand(command)).toEqual({ action: "allow" });
    }
  });

  it("工作区内的删除不需要审批，交给沙箱与 Git 兜底", () => {
    // 审批必须稀有：把工作区内的常规删除也拿去问，用户很快就会条件反射点同意。
    expect(evaluateCommand("rm -rf node_modules").action).toBe("allow");
    expect(evaluateCommand("rm -rf dist").action).toBe("allow");
    expect(evaluateCommand("rm -rf /tmp/scratch").action).toBe("allow");
  });

  it("指向根目录与主目录的递归删除被硬拒", () => {
    expect(evaluateCommand("rm -rf /")).toEqual({ action: "block", reason: "递归删除根目录" });
    expect(evaluateCommand("rm -rf / --no-preserve-root").action).toBe("block");
    expect(evaluateCommand("rm -rf ~").action).toBe("block");
    expect(evaluateCommand("rm -rf $HOME/").action).toBe("block");
  });

  it("其余灾难性命令被硬拒", () => {
    expect(evaluateCommand(":(){ :|:& };:").action).toBe("block");
    expect(evaluateCommand("mkfs.ext4 /dev/sda1").action).toBe("block");
    expect(evaluateCommand("dd if=/dev/zero of=/dev/disk2").action).toBe("block");
  });

  it("外部可见的操作需要审批", () => {
    expect(evaluateCommand("git push origin master").action).toBe("approve");
    expect(evaluateCommand("git push --force").action).toBe("approve");
    expect(evaluateCommand("pnpm publish").action).toBe("approve");
  });

  it("会吃掉未提交改动的命令按工作树状态判定", () => {
    expect(evaluateCommand("git reset --hard HEAD~1").action).toBe("approve_if_dirty");
    expect(evaluateCommand("git clean -fd").action).toBe("approve_if_dirty");
    expect(evaluateCommand("git checkout -- .").action).toBe("approve_if_dirty");
    expect(evaluateCommand("git restore .").action).toBe("approve_if_dirty");
  });

  it("硬拒优先于审批", () => {
    expect(evaluateCommand("git push && rm -rf /").action).toBe("block");
  });

  it("判定结果附带面向用户的中文原因", () => {
    const verdict = evaluateCommand("git push");
    expect(verdict.action).toBe("approve");
    if (verdict.action === "approve") expect(verdict.reason).toContain("远端");
  });
});
