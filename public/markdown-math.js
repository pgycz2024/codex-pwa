function firstMatchIndex(...indices) {
  const matches = indices.filter((index) => index >= 0);
  return matches.length ? Math.min(...matches) : undefined;
}

function tokenizeBlockMath(source) {
  const bracketed = /^ {0,3}\\\[[ \t]*\n?([\s\S]*?)\n?[ \t]*\\\](?:[ \t]*(?:\n|$))/.exec(source);
  if (bracketed) {
    return { raw: bracketed[0], text: bracketed[1].trim() };
  }

  const dollars = /^ {0,3}\$\$[ \t]*\n?([\s\S]*?)\n?[ \t]*\$\$(?:[ \t]*(?:\n|$))/.exec(source);
  if (dollars) {
    return { raw: dollars[0], text: dollars[1].trim() };
  }

  return null;
}

function tokenizeInlineMath(source) {
  const bracketed = /^\\\(([^\n]+?)\\\)/.exec(source);
  if (bracketed) {
    return { raw: bracketed[0], text: bracketed[1].trim() };
  }

  const dollars = /^\$(?!\$)([^$\n]+?)\$(?!\d)/.exec(source);
  if (!dollars || /^\s|\s$/.test(dollars[1])) return null;
  return { raw: dollars[0], text: dollars[1] };
}

export function createMathExtensions(renderMath) {
  return [
    {
      name: "blockMath",
      level: "block",
      start(source) {
        return firstMatchIndex(source.search(/(?:^|\n) {0,3}\\\[/), source.search(/(?:^|\n) {0,3}\$\$/));
      },
      tokenizer(source) {
        const token = tokenizeBlockMath(source);
        if (!token) return undefined;
        return { type: "blockMath", ...token };
      },
      renderer(token) {
        return `${renderMath(token.text, true)}\n`;
      },
    },
    {
      name: "inlineMath",
      level: "inline",
      start(source) {
        return firstMatchIndex(source.indexOf("\\("), source.indexOf("$"));
      },
      tokenizer(source) {
        const token = tokenizeInlineMath(source);
        if (!token) return undefined;
        return { type: "inlineMath", ...token };
      },
      renderer(token) {
        return renderMath(token.text, false);
      },
    },
  ];
}
