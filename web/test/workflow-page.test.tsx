// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { WorkflowPage } from "../src/pages/workflow/WorkflowPage";

const api = vi.hoisted(() => ({ loadLocalWorkflow: vi.fn(), saveLocalWorkflow: vi.fn(), runLocalWorkflow: vi.fn() }));
vi.mock("../src/workflow-api", () => api);
vi.mock("../src/pages/workflow/GraphCanvas", () => ({ GraphCanvas: () => <div>拓扑</div> }));
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });

it.each([true, false])("编辑权限=%s 时页面保持选择和运行入口，并按权限控制编辑和自动保存", async (editable) => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  const workflow = { name: "示例", nodes: [], edges: [] };
  const files = editable ? ["first.ts", "second.ts"] : ["first.js", "second.js"];
  api.loadLocalWorkflow.mockImplementation(async (file) => ({ editable, files, selectedFile: file ?? files[0], source: "原始代码", workflow }));
  api.saveLocalWorkflow.mockResolvedValue({ workflow });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<WorkflowPage />));
    const editor = container.querySelector<HTMLTextAreaElement>('[aria-label="工作流代码"]')!;
    expect(editor.readOnly).toBe(!editable);
    expect(container.textContent).toContain(editable ? "src/workflows/" : "dist-server/src/workflows/");
    if (!editable) expect(container.textContent).toContain("生产环境只读");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor, "修改代码");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    if (editable) expect(api.saveLocalWorkflow).toHaveBeenCalledWith(files[0], "修改代码");
    else expect(api.saveLocalWorkflow).not.toHaveBeenCalled();
    const picker = container.querySelector<HTMLSelectElement>('[aria-label="本地工作流文件"]')!;
    await act(async () => { picker.value = files[1]!; picker.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(api.loadLocalWorkflow).toHaveBeenLastCalledWith(files[1]);
    expect(container.querySelector('[aria-label="工作流代码"]')).not.toBeNull();
    expect([...container.querySelectorAll("button")].some((button) => button.textContent?.includes("执行工作流") && !button.disabled)).toBe(true);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
