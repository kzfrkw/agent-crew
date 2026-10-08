import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * 成果物の Markdown。react-markdown は生の HTML を描画しない(エージェントが書いた内容をそのまま信用しない)。
 * リンクは新しいタブで開き、参照元を送らない。
 */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
