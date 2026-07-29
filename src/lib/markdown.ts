import { parseDocument } from 'yaml'

export type FrontmatterEntry = {
	key: string
	value: unknown
}

export type MarkdownHeading = {
	id: string
	level: number
	text: string
	from: number
}

export type MarkdownPreviewDocument = {
	body: string
	frontmatter: FrontmatterEntry[]
	frontmatterError?: string
	headings: MarkdownHeading[]
}

type MarkdownAstNode = {
	type?: string
	value?: string
	children?: MarkdownAstNode[]
	data?: {
		hProperties?: Record<string, string>
	}
}

function plainHeadingText(value: string): string {
	return value
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
		.replace(/<[^>]+>/g, '')
		.replace(/[`*_~]/g, '')
		.trim()
}

function astText(node: MarkdownAstNode): string {
	if (typeof node.value === 'string') return node.value
	return (node.children ?? []).map(astText).join('')
}

function headingSlug(value: string): string {
	const slug = plainHeadingText(value)
		.toLocaleLowerCase()
		.replace(/[^\p{Letter}\p{Number}\p{Mark}\s_-]/gu, '')
		.trim()
		.replace(/\s+/g, '-')
		.replace(/-+/g, '-')
	return slug || 'section'
}

function uniqueHeadingId(
	text: string,
	occurrences: Map<string, number>,
): string {
	const base = headingSlug(text)
	const occurrence = occurrences.get(base) ?? 0
	occurrences.set(base, occurrence + 1)
	return occurrence === 0 ? base : `${base}-${occurrence}`
}

function extractHeadings(
	markdown: string,
	documentOffset: number,
): MarkdownHeading[] {
	const headings: MarkdownHeading[] = []
	const occurrences = new Map<string, number>()
	const lines = markdown.split(/\r?\n/)
	const lineOffsets: number[] = []
	let offset = 0
	for (const line of lines) {
		lineOffsets.push(offset)
		offset += line.length
		if (markdown.startsWith('\r\n', offset)) offset += 2
		else if (markdown[offset] === '\n') offset += 1
	}
	let fence: { marker: '`' | '~'; length: number } | null = null

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index]
		const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/)
		if (fenceMatch) {
			const marker = fenceMatch[1][0] as '`' | '~'
			if (!fence) {
				fence = { marker, length: fenceMatch[1].length }
			} else if (
				fence.marker === marker &&
				fenceMatch[1].length >= fence.length
			) {
				fence = null
			}
			continue
		}
		if (fence) continue

		const atx = line.match(/^\s{0,3}(#{1,6})(?:\s+|$)(.*?)\s*$/)
		if (atx) {
			const text = plainHeadingText(atx[2].replace(/\s+#+\s*$/, ''))
			if (text) {
				headings.push({
					id: uniqueHeadingId(text, occurrences),
					level: atx[1].length,
					text,
					from: documentOffset + lineOffsets[index],
				})
			}
			continue
		}

		const underline = lines[index + 1]?.match(/^\s{0,3}(=+|-+)\s*$/)
		if (underline && line.trim() && !/^\s{4}/.test(line)) {
			const text = plainHeadingText(line)
			if (text) {
				headings.push({
					id: uniqueHeadingId(text, occurrences),
					level: underline[1][0] === '=' ? 1 : 2,
					text,
					from: documentOffset + lineOffsets[index],
				})
			}
			index += 1
		}
	}

	return headings
}

export function parseMarkdownDocument(markdown: string): MarkdownPreviewDocument {
	const source = markdown.replace(/^\uFEFF/, '')
	const sourceOffset = source === markdown ? 0 : 1
	const frontmatterMatch = source.match(
		/^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/,
	)
	let body = source
	let bodyOffset = sourceOffset
	let frontmatter: FrontmatterEntry[] = []
	let frontmatterError: string | undefined

	if (frontmatterMatch) {
		body = source.slice(frontmatterMatch[0].length)
		bodyOffset += frontmatterMatch[0].length
		try {
			const document = parseDocument(frontmatterMatch[1], {
				logLevel: 'silent',
			})
			if (document.errors.length > 0) {
				frontmatterError = document.errors[0].message
			} else {
				const value = document.toJS({ maxAliasCount: 50 })
				if (
					value !== null &&
					typeof value === 'object' &&
					!Array.isArray(value)
				) {
					frontmatter = Object.entries(
						value as Record<string, unknown>,
					).map(([key, entryValue]) => ({ key, value: entryValue }))
				} else if (value !== null) {
					frontmatterError =
						'Frontmatterのルートは key: value 形式で記述してください。'
				}
			}
		} catch (caught) {
			frontmatterError =
				caught instanceof Error
					? caught.message
					: 'Frontmatterを解析できませんでした。'
		}
	} else if (/^---[ \t]*(?:\r?\n|$)/.test(source)) {
		frontmatterError = 'Frontmatterを閉じる --- が見つかりません。'
	}

	return {
		body,
		frontmatter,
		frontmatterError,
		headings: extractHeadings(body, bodyOffset),
	}
}

export function remarkHeadingIds() {
	return (tree: MarkdownAstNode) => {
		const occurrences = new Map<string, number>()
		const visit = (node: MarkdownAstNode) => {
			if (node.type === 'heading') {
				const id = uniqueHeadingId(astText(node), occurrences)
				node.data = node.data ?? {}
				node.data.hProperties = {
					...node.data.hProperties,
					id,
				}
			}
			for (const child of node.children ?? []) visit(child)
		}
		visit(tree)
	}
}
