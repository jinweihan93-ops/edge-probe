/** @jsxImportSource hono/jsx */

/**
 * Expandable content block, per DESIGN.md §Expandable content block on
 * `/app/trace/{id}` (auth'd only). This component literally does not exist
 * on the public surface — we do not import it from publicTrace.tsx.
 *
 * Prompt / completion / transcript are rendered as plain preformatted text.
 * No markdown, no linkification — the data is adversarial input.
 */
export function ContentBlock({
  promptText,
  completionText,
  transcriptText,
}: {
  promptText?: string | null
  completionText?: string | null
  transcriptText?: string | null
}) {
  const hasAny = Boolean(promptText || completionText || transcriptText)
  if (!hasAny) return null

  return (
    <div class="content-block" role="region" aria-label="Captured content (org members only)">
      <div class="content-block__head">
        <div class="content-block__title">Captured content</div>
        <div class="content-block__scope">Org members only</div>
      </div>

      {promptText && (
        <div class="content-block__section">
          <div class="content-block__label">Prompt</div>
          <pre class="content-block__body">{promptText}</pre>
        </div>
      )}

      {completionText && (
        <div class="content-block__section">
          <div class="content-block__label">Completion</div>
          <pre class="content-block__body">{completionText}</pre>
        </div>
      )}

      {transcriptText && (
        <div class="content-block__section">
          <div class="content-block__label">Transcript</div>
          <pre class="content-block__body">{transcriptText}</pre>
        </div>
      )}
    </div>
  )
}
