import { type ReactNode, useContext } from 'react';
import { MarkdownImageSourceContext } from './markdownImageSource.ts';

const renderText = (value: string, keyPrefix: string): Array<ReactNode> => {
  const textNodes: Array<ReactNode> = [];
  const emphasisPattern =
    /\*\*([^*\n]+)\*\*|(?<![\w_])_([^_\n]+)_(?![\w_])|(?<![\w*])\*([^*\n]+)\*(?![\w*])/g;
  let textLastIndex = 0;
  let emphasisMatch: RegExpExecArray | null;

  while ((emphasisMatch = emphasisPattern.exec(value))) {
    if (emphasisMatch.index > textLastIndex) {
      textNodes.push(value.slice(textLastIndex, emphasisMatch.index));
    }

    if (emphasisMatch[1] != null) {
      textNodes.push(
        <strong key={`${keyPrefix}:bold:${emphasisMatch.index}`}>{emphasisMatch[1]}</strong>,
      );
    } else {
      textNodes.push(
        <em key={`${keyPrefix}:italic:${emphasisMatch.index}`}>
          {emphasisMatch[2] ?? emphasisMatch[3]}
        </em>,
      );
    }
    textLastIndex = emphasisPattern.lastIndex;
  }

  if (textLastIndex < value.length) {
    textNodes.push(value.slice(textLastIndex));
  }

  return textNodes.length > 0 ? textNodes : [value];
};

const getSafeLinkTarget = (target: string) => {
  const trimmed = target.trim();
  if (trimmed.startsWith('/') || trimmed.startsWith('#')) {
    return trimmed;
  }

  try {
    const url = new URL(trimmed);
    return url.protocol === 'http:' || url.protocol === 'https:' ? trimmed : null;
  } catch {
    return null;
  }
};

const getMarkdownLinkTarget = (value: string) => {
  const trimmed = value.trim();
  const target = /^(\S+)(?:\s+(?:"[^"]*"|'[^']*'))?$/.exec(trimmed)?.[1] ?? trimmed;

  return getSafeLinkTarget(target);
};

const getSafeImageSource = (source: string) => {
  const trimmed = source.trim();

  try {
    const url = new URL(trimmed);
    return url.protocol === 'http:' || url.protocol === 'https:' ? trimmed : null;
  } catch {
    return null;
  }
};

const getHtmlAttribute = (html: string, name: string) => {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`, 'i').exec(
    html,
  );
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? '';
};

const getImageDimension = (value: string) => (/^\d{1,5}$/.test(value) ? value : undefined);

const MarkdownImage = ({
  alt,
  height,
  source,
  width,
}: {
  alt: string;
  height?: string;
  source: string;
  width?: string;
}) => {
  const resolveImageSource = useContext(MarkdownImageSourceContext);
  return (
    <img
      alt={alt}
      className="codiff-markdown-image"
      decoding="async"
      height={height}
      loading="lazy"
      src={resolveImageSource ? resolveImageSource(source) : source}
      width={width}
    />
  );
};

const renderImage = (
  source: string,
  alt: string,
  key: string,
  dimensions: { height?: string; width?: string } = {},
) => {
  const safeSource = getSafeImageSource(source);
  if (!safeSource) {
    return null;
  }

  return <MarkdownImage alt={alt} key={key} source={safeSource} {...dimensions} />;
};

export const sanitizeMarkdownImages = (text: string): string =>
  text.replaceAll(
    /!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\)|<img\b[^>]*>/gi,
    (match, markdownAlt: string | undefined, markdownSource: string | undefined) => {
      const htmlImage = match.startsWith('<');
      const source = htmlImage ? getHtmlAttribute(match, 'src') : (markdownSource ?? '');
      if (getSafeImageSource(source)) {
        return match;
      }

      const alt = htmlImage ? getHtmlAttribute(match, 'alt') : (markdownAlt ?? '');
      return alt;
    },
  );

const findMarkdownLinkClose = (text: string, startIndex: number) => {
  let depth = 0;

  for (let index = startIndex; index < text.length; index += 1) {
    const character = text[index];
    if (character === '\n') {
      return -1;
    }
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      if (depth === 0) {
        return index;
      }
      depth -= 1;
    }
  }

  return -1;
};

export const renderInlineMarkdown = (text: string): ReactNode => {
  const nodes: Array<ReactNode> = [];
  let lastIndex = 0;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (character === '`') {
      const endIndex = text.indexOf('`', index + 1);
      if (endIndex === -1 || text.slice(index + 1, endIndex).includes('\n')) {
        continue;
      }

      const code = text.slice(index + 1, endIndex);
      if (!code) {
        continue;
      }

      if (index > lastIndex) {
        nodes.push(...renderText(text.slice(lastIndex, index), `${lastIndex}`));
      }
      nodes.push(
        <code className="walkthrough-inline-code" key={`${index}:${code}`}>
          {code}
        </code>,
      );
      index = endIndex;
      lastIndex = endIndex + 1;
      continue;
    }

    if (character === '!' && text[index + 1] === '[') {
      const labelEndIndex = text.indexOf(']', index + 2);
      if (labelEndIndex === -1 || text.slice(index + 2, labelEndIndex).includes('\n')) {
        continue;
      }
      if (text[labelEndIndex + 1] !== '(') {
        continue;
      }

      const imageEndIndex = findMarkdownLinkClose(text, labelEndIndex + 2);
      if (imageEndIndex === -1) {
        continue;
      }

      const alt = text.slice(index + 2, labelEndIndex);
      const target = getMarkdownLinkTarget(text.slice(labelEndIndex + 2, imageEndIndex));
      const image = target ? renderImage(target, alt, `image:${index}`) : null;
      if (!image) {
        continue;
      }

      if (index > lastIndex) {
        nodes.push(...renderText(text.slice(lastIndex, index), `${lastIndex}`));
      }
      nodes.push(image);
      index = imageEndIndex;
      lastIndex = imageEndIndex + 1;
      continue;
    }

    if (text.slice(index, index + 4).toLowerCase() === '<img') {
      const endIndex = text.indexOf('>', index + 4);
      if (endIndex === -1 || text.slice(index, endIndex).includes('\n')) {
        continue;
      }

      const html = text.slice(index, endIndex + 1);
      const image = renderImage(
        getHtmlAttribute(html, 'src'),
        getHtmlAttribute(html, 'alt'),
        `image:${index}`,
        {
          height: getImageDimension(getHtmlAttribute(html, 'height')),
          width: getImageDimension(getHtmlAttribute(html, 'width')),
        },
      );
      if (!image) {
        continue;
      }

      if (index > lastIndex) {
        nodes.push(...renderText(text.slice(lastIndex, index), `${lastIndex}`));
      }
      nodes.push(image);
      index = endIndex;
      lastIndex = endIndex + 1;
      continue;
    }

    if (character === '[') {
      const labelEndIndex = text.indexOf(']', index + 1);
      if (labelEndIndex === -1 || text.slice(index + 1, labelEndIndex).includes('\n')) {
        continue;
      }
      if (text[labelEndIndex + 1] !== '(') {
        continue;
      }

      const linkEndIndex = findMarkdownLinkClose(text, labelEndIndex + 2);
      if (linkEndIndex === -1) {
        continue;
      }

      const label = text.slice(index + 1, labelEndIndex);
      const target = getMarkdownLinkTarget(text.slice(labelEndIndex + 2, linkEndIndex));
      if (!label || !target) {
        continue;
      }

      if (index > lastIndex) {
        nodes.push(...renderText(text.slice(lastIndex, index), `${lastIndex}`));
      }
      nodes.push(
        <a href={target} key={`${index}:${target}`} rel="noreferrer" target="_blank">
          {renderText(label, `${index}:link`)}
        </a>,
      );
      index = linkEndIndex;
      lastIndex = linkEndIndex + 1;
    }
  }

  if (lastIndex < text.length) {
    nodes.push(...renderText(text.slice(lastIndex), `${lastIndex}`));
  }

  return nodes.length > 0 ? nodes : text;
};

/**
 * Block Markdown for agent-written text: `#` headings, `-`/`*`/`1.` lists and paragraphs, each with
 * inline Markdown. Enough for briefings and narration; anything else reads as plain text.
 */
export const renderBlockMarkdown = (text: string): Array<ReactNode> => {
  const blocks: Array<ReactNode> = [];
  let paragraph: Array<string> = [];
  let list: { items: Array<string>; ordered: boolean } | null = null;
  const flush = () => {
    if (paragraph.length) {
      blocks.push(<p key={blocks.length}>{renderInlineMarkdown(paragraph.join(' '))}</p>);
      paragraph = [];
    }
    if (list) {
      const items = list.items.map((item, index) => (
        <li key={index}>{renderInlineMarkdown(item)}</li>
      ));
      blocks.push(
        list.ordered ? <ol key={blocks.length}>{items}</ol> : <ul key={blocks.length}>{items}</ul>,
      );
      list = null;
    }
  };
  for (const line of text.split('\n')) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const item = /^\s*(?:[-*+]|(\d+)[.)])\s+(.*)$/.exec(line);
    if (!line.trim()) {
      flush();
    } else if (heading) {
      flush();
      blocks.push(<h4 key={blocks.length}>{renderInlineMarkdown(heading[1])}</h4>);
    } else if (item) {
      const ordered = item[1] != null;
      if (paragraph.length || (list && list.ordered !== ordered)) {
        flush();
      }
      list ??= { items: [], ordered };
      list.items.push(item[2]);
    } else if (list && /^\s/.test(line)) {
      // An indented line continues the last list item.
      list.items[list.items.length - 1] += ` ${line.trim()}`;
    } else {
      if (list) {
        flush();
      }
      paragraph.push(line.trim());
    }
  }
  flush();
  return blocks;
};
