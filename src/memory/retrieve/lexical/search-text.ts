const HAN = /\p{Script=Han}/u;
const WORDS = /[\p{L}\p{N}_]+/gu;

/** 将原文转换为适合 FTS5 unicode61 的中英文检索投影。 */
export function toSearchText(value: string): string {
  const normalized = value.normalize("NFKC").toLocaleLowerCase();
  const tokens: string[] = [];
  let hanRun = "";
  const flushHan = () => {
    const chars = [...hanRun];
    if (chars.length === 1) tokens.push(chars[0]!);
    for (let index = 0; index < chars.length - 1; index += 1) tokens.push(`${chars[index]}${chars[index + 1]}`);
    hanRun = "";
  };
  for (const character of normalized) {
    if (HAN.test(character)) hanRun += character;
    else flushHan();
  }
  flushHan();
  const withoutHan = normalized.replace(/\p{Script=Han}/gu, " ");
  tokens.push(...(withoutHan.match(WORDS) ?? []));
  return [...new Set(tokens.filter(Boolean))].join(" ");
}

/** 生成参数化 MATCH 表达式；不把用户原文拼接进 SQL。 */
export function toMatchQuery(value: string): string {
  const tokens = toSearchText(value).split(/\s+/).filter(Boolean);
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ");
}
