import { ListTree } from 'lucide-react'
import { useMemo, type CSSProperties, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkFrontmatter from 'remark-frontmatter'
import remarkGfm from 'remark-gfm'
import {
	parseMarkdownDocument,
	remarkHeadingIds,
	type MarkdownHeading,
} from '../lib/markdown'
import type { PendingAsset, SessionMeta } from '../lib/types'

type MarkdownPreviewProps = {
	markdown: string
	meta: SessionMeta
	assets: PendingAsset[]
}

type PositionedNode = {
	position?: {
		start?: { offset?: number }
		end?: { offset?: number }
	}
}

function sourcePositionAttributes(
	node: PositionedNode | undefined,
	bodyOffset: number,
) {
	const start = node?.position?.start?.offset
	const end = node?.position?.end?.offset
	return {
		...(typeof start === 'number'
			? { 'data-source-start': bodyOffset + start }
			: {}),
		...(typeof end === 'number'
			? { 'data-source-end': bodyOffset + end }
			: {}),
	}
}

function normalizePath(path: string): string {
	const parts: string[] = []
	for (const part of path.split('/')) {
		if (!part || part === '.') continue
		if (part === '..') parts.pop()
		else parts.push(part)
	}
	return parts.join('/')
}

function resolveRelativePath(documentPath: string, source: string): string {
	const directory = documentPath.includes('/')
		? documentPath.slice(0, documentPath.lastIndexOf('/'))
		: ''
	return normalizePath(`${directory}/${source}`)
}

function isWebUrl(value: string): boolean {
	return /^https?:\/\/\S+$/i.test(value)
}

function renderFrontmatterValue(value: unknown): ReactNode {
	if (Array.isArray(value)) {
		return (
			<span className="frontmatter-values">
				{value.map((entry, index) => (
					<span className="frontmatter-chip" key={`${String(entry)}-${index}`}>
						{renderFrontmatterValue(entry)}
					</span>
				))}
			</span>
		)
	}
	if (value !== null && typeof value === 'object') {
		return (
			<code className="frontmatter-object">
				{JSON.stringify(value)}
			</code>
		)
	}
	if (value === null) return <span className="frontmatter-empty">null</span>

	const label = String(value)
	if (isWebUrl(label)) {
		return (
			<a href={label} target="_blank" rel="noreferrer">
				{label}
			</a>
		)
	}
	return label
}

type DocumentTocProps = {
	headings: MarkdownHeading[]
	variant: 'editor' | 'preview'
	onNavigate?: (heading: MarkdownHeading) => void
}

function DocumentToc({
	headings,
	variant,
	onNavigate,
}: DocumentTocProps) {
	if (headings.length === 0) return null
	const minimumLevel = Math.min(...headings.map((heading) => heading.level))

	return (
		<aside
			className={`preview-toc ${variant}-toc`}
			aria-label={variant === 'editor' ? 'エディタの目次' : '文書の目次'}
		>
			<button
				type="button"
				className="preview-toc-trigger"
				aria-label="目次を表示"
			>
				<span />
				<ListTree size={15} />
			</button>
			<nav className="preview-toc-panel" aria-label="目次">
				<header>
					<ListTree size={15} />
					<span>目次</span>
					<small>{headings.length} headings</small>
				</header>
				<div>
					{headings.map((heading) => (
						<a
							key={heading.id}
							href={`#${heading.id}`}
							style={{
								'--toc-indent': `${Math.min(
									heading.level - minimumLevel,
									3,
								) * 13}px`,
							} as CSSProperties}
							onClick={(event) => {
								event.preventDefault()
								if (onNavigate) {
									onNavigate(heading)
								} else {
									document
										.getElementById(heading.id)
										?.scrollIntoView({
											behavior: 'smooth',
											block: 'start',
										})
								}
							}}
						>
							{heading.text}
						</a>
					))}
				</div>
			</nav>
		</aside>
	)
}

export function EditorToc({
	headings,
	onNavigate,
}: Omit<DocumentTocProps, 'variant'>) {
	return (
		<DocumentToc
			headings={headings}
			variant="editor"
			onNavigate={onNavigate}
		/>
	)
}

export function PreviewToc({ headings }: { headings: MarkdownHeading[] }) {
	return <DocumentToc headings={headings} variant="preview" />
}

export function MarkdownPreview({ markdown, meta, assets }: MarkdownPreviewProps) {
	const document = useMemo(() => parseMarkdownDocument(markdown), [markdown])
	const resolveImage = (source: string | undefined): string | undefined => {
		if (!source || /^(?:https?:|data:|blob:)/i.test(source)) return source
		const normalizedSource = source.replace(/^\.\//, '')
		const pending = assets.find(
			(asset) =>
				asset.markdownPath.replace(/^\.\//, '') === normalizedSource ||
				asset.finalPath === resolveRelativePath(meta.documentPath, source),
		)
		if (pending) {
			return pending.previewUrl ?? `/api/sessions/${meta.id}/assets/${pending.id}`
		}
		if (!meta.repository || !meta.baseBranch) return source
		const resolved = resolveRelativePath(meta.documentPath, source)
		return `https://raw.githubusercontent.com/${meta.repository}/${encodeURIComponent(meta.baseBranch)}/${resolved
			.split('/')
			.map(encodeURIComponent)
			.join('/')}`
	}

	return (
		<article className="markdown-preview">
			{document.frontmatter.length > 0 && (
				<section
					className="frontmatter-card"
					aria-label="Frontmatter"
					data-source-start={0}
				>
					<table className="frontmatter-table">
						<tbody>
							{document.frontmatter.map(({ key, value }) => (
								<tr key={key}>
									<th scope="row">{key}</th>
									<td>{renderFrontmatterValue(value)}</td>
								</tr>
							))}
						</tbody>
					</table>
				</section>
			)}
			{document.frontmatterError && (
				<div
					className="frontmatter-error"
					role="status"
					data-source-start={0}
				>
					<strong>Frontmatterを解析できません</strong>
					<span>{document.frontmatterError}</span>
				</div>
			)}
			<ReactMarkdown
				remarkPlugins={[remarkFrontmatter, remarkGfm, remarkHeadingIds]}
				components={{
					h1: ({ node, children, ...props }) => (
						<h1 {...props} {...sourcePositionAttributes(node, document.bodyOffset)}>
							{children}
						</h1>
					),
					h2: ({ node, children, ...props }) => (
						<h2 {...props} {...sourcePositionAttributes(node, document.bodyOffset)}>
							{children}
						</h2>
					),
					h3: ({ node, children, ...props }) => (
						<h3 {...props} {...sourcePositionAttributes(node, document.bodyOffset)}>
							{children}
						</h3>
					),
					h4: ({ node, children, ...props }) => (
						<h4 {...props} {...sourcePositionAttributes(node, document.bodyOffset)}>
							{children}
						</h4>
					),
					h5: ({ node, children, ...props }) => (
						<h5 {...props} {...sourcePositionAttributes(node, document.bodyOffset)}>
							{children}
						</h5>
					),
					h6: ({ node, children, ...props }) => (
						<h6 {...props} {...sourcePositionAttributes(node, document.bodyOffset)}>
							{children}
						</h6>
					),
					p: ({ node, children, ...props }) => (
						<p {...props} {...sourcePositionAttributes(node, document.bodyOffset)}>
							{children}
						</p>
					),
					li: ({ node, children, ...props }) => (
						<li {...props} {...sourcePositionAttributes(node, document.bodyOffset)}>
							{children}
						</li>
					),
					pre: ({ node, children, ...props }) => (
						<pre {...props} {...sourcePositionAttributes(node, document.bodyOffset)}>
							{children}
						</pre>
					),
					table: ({ node, children, ...props }) => (
						<table {...props} {...sourcePositionAttributes(node, document.bodyOffset)}>
							{children}
						</table>
					),
					hr: ({ node, ...props }) => (
						<hr {...props} {...sourcePositionAttributes(node, document.bodyOffset)} />
					),
					a: ({ node: _node, children, href, ...props }) => (
						<a {...props} href={href} target="_blank" rel="noreferrer">
							{children}
						</a>
					),
					img: ({ node: _node, alt, src, ...props }) => (
						<img
							{...props}
							alt={alt ?? ''}
							src={resolveImage(src)}
							loading="lazy"
						/>
					),
					input: ({ node: _node, ...props }) => <input {...props} disabled />,
				}}
			>
				{document.body}
			</ReactMarkdown>
		</article>
	)
}
