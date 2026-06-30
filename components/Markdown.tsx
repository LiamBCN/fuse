"use client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Renders content as GitHub-flavored Markdown (tables, task lists,
// strikethrough, fenced code, links). Monochrome by design - code blocks
// are styled in globals.css, no syntax colors. Adapts to light/dark via
// Tailwind Typography's `dark:prose-invert`.
export default function Markdown({ children }: { children: string }) {
  return (
    <div className="prose dark:prose-invert max-w-none prose-sm leading-relaxed prose-pre:my-3 prose-code:before:content-none prose-code:after:content-none prose-headings:font-semibold prose-a:text-fg prose-a:underline">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
          code: ({ node, className, children, ...props }) => {
            const isBlock = className?.includes("language-");
            if (isBlock) {
              return <code className={className} {...props}>{children}</code>;
            }
            return (
              <code className="rounded bg-subtle px-1.5 py-0.5 text-[0.85em]" {...props}>
                {children}
              </code>
            );
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
