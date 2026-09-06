import nodejieba from "nodejieba";

const HAN_RUN = /^(?:\p{Script=Han})+$/u;
// 路径分隔符只在 @scope/pkg 中属于整体；其余路径自然分成目录和文件名。
const IDENTIFIERS = /@[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*|[a-zA-Z](?:\+\+|#)|_*[\p{L}\p{N}]+(?:[_.-]+[\p{L}\p{N}]+)*_*/gu;

/** 将原文转换为 FTS5 检索投影；保留位置词频，配合 Schema 中的 tokenchars 使用。 */
export function toSearchText(value: string): string {
  const tokens: string[] = [];
  // 在 lowercase 前识别驼峰；中文单独交给 jieba，避免它拆散技术名称。
  for (const run of value.normalize("NFKC").split(/(\p{Script=Han}+)/u)) {
    if (HAN_RUN.test(run)) {
      // 搜索模式按原文位置输出词元，同词在不同位置的重复不能去重。
      for (const word of nodejieba.cutForSearch(run, true)) tokens.push(word);
      continue;
    }
    for (const match of run.matchAll(IDENTIFIERS)) {
      const identifier = match[0];
      const positions = new Set<string>();
      const add = (word: string, offset: number) => {
        const normalized = word.toLowerCase();
        const key = `${offset}:${normalized}`;
        // 整体与组成词在同一位置重合时只记一次；不同位置出现同词仍累计词频。
        if (!positions.has(key)) { positions.add(key); tokens.push(normalized); }
      };
      add(identifier, 0);
      for (const component of identifier.matchAll(/[\p{L}\p{N}]+/gu)) {
        let offset = component.index;
        for (const word of component[0].split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/u)) {
          add(word, offset);
          offset += word.length;
        }
      }
    }
  }
  return tokens.join(" ");
}

/** 查询词去重后按 OR 连接；引号保护每个词元，不执行用户输入的 MATCH 语法。 */
export function toMatchQuery(value: string): string {
  const tokens = new Set(toSearchText(value).split(/\s+/).filter(Boolean));
  return [...tokens].map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ");
}
