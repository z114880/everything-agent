import { Check, Code2, RefreshCw } from "lucide-react";
import { useMemo, useRef } from "react";

interface CodeEditorProps {
  code: string;
  error: string;
  workflowFiles: string[];
  selectedFile: string;
  switching: boolean;
  onChange: (code: string) => void;
  onSelect: (file: string) => void;
  onReset: () => void;
}

export function CodeEditor(props: CodeEditorProps) {
  const { code, error, workflowFiles, selectedFile, switching, onChange, onSelect, onReset } = props;
  const gutterRef = useRef<HTMLDivElement>(null);
  const lineNumbers = useMemo(() => code.split("\n").map((_, index) => index + 1), [code]);

  return (
    <section className="panel overflow-hidden">
      <div className="panel-header">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Code2 size={15} />
          <span>工作流代码</span>
          <label className="workflow-picker" title="选择 src/workflows 中的本地工作流">
            <Check size={11} />
            <span>已连接本地 Engine ·</span>
            <select
              aria-label="本地工作流文件"
              value={selectedFile}
              disabled={switching || workflowFiles.length === 0}
              onChange={(event) => onSelect(event.target.value)}
            >
              {workflowFiles.map((file) => (
                <option key={file} value={file}>src/workflows/{file}</option>
              ))}
            </select>
          </label>
        </div>
        <button className="icon-button" onClick={onReset} title="从本地文件重新读取">
          <RefreshCw size={14} />
          重新读取
        </button>
      </div>
      <div className="code-shell">
        <div ref={gutterRef} className="line-numbers" aria-hidden="true">
          {lineNumbers.map((line) => <div key={line}>{line}</div>)}
        </div>
        <textarea
          aria-label="TypeScript 工作流代码"
          className="code-input"
          value={code}
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
          onScroll={(event) => {
            if (gutterRef.current) gutterRef.current.scrollTop = event.currentTarget.scrollTop;
          }}
        />
      </div>
      <div className={`editor-footer ${error ? "text-red-600" : "text-emerald-700"}`}>
        <span className={`signal ${error ? "bg-red-500" : "bg-emerald-500"}`} />
        {error || "已保存到本地，拓扑来自 Graph.describe()"}
      </div>
    </section>
  );
}
