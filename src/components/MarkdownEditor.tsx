import { markdown } from '@codemirror/lang-markdown'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { basicSetup } from 'codemirror'
import {
	forwardRef,
	useEffect,
	useImperativeHandle,
	useRef,
} from 'react'
import { yCollab } from 'y-codemirror.next'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as Y from 'yjs'
import type { EditorColorScheme } from '../lib/editorColorSchemes'
import { exceedsUtf8ByteLimit, MAX_MARKDOWN_BYTES } from '../lib/limits'

export type MarkdownEditorHandle = {
	wrapSelection: (before: string, after?: string) => void
	insertText: (text: string) => void
	scrollToPosition: (position: number) => void
	scrollToProgress: (progress: number) => boolean
	focus: () => void
}

type MarkdownEditorProps = {
	text: Y.Text
	awareness: awarenessProtocol.Awareness
	readOnly?: boolean
	onPasteImages?: (files: File[]) => void
	onScrollProgress?: (progress: number) => void
	onDocumentLimitExceeded?: () => void
	colorScheme: EditorColorScheme
}

type EditorPalette = {
	dark: boolean
	background: string
	foreground: string
	gutter: string
	gutterText: string
	activeLine: string
	activeGutter: string
	accent: string
	selection: string
	heading: string
	link: string
	code: string
	quote: string
	punctuation: string
}

const EDITOR_PALETTES: Record<EditorColorScheme, EditorPalette> = {
	midnight: {
		dark: true,
		background: '#111510',
		foreground: '#e8eee4',
		gutter: '#111510',
		gutterText: '#64705f',
		activeLine: '#1a2018',
		activeGutter: '#93a58b',
		accent: '#b7f36b',
		selection: '#3f5d2d',
		heading: '#b7f36b',
		link: '#65d9ff',
		code: '#e7c46a',
		quote: '#a9b9a2',
		punctuation: '#82917c',
	},
	'github-dark': {
		dark: true,
		background: '#0d1117',
		foreground: '#c9d1d9',
		gutter: '#0d1117',
		gutterText: '#6e7681',
		activeLine: '#161b22',
		activeGutter: '#8b949e',
		accent: '#58a6ff',
		selection: '#264f78',
		heading: '#79c0ff',
		link: '#58a6ff',
		code: '#ffa657',
		quote: '#8b949e',
		punctuation: '#8b949e',
	},
	paper: {
		dark: false,
		background: '#ffffff',
		foreground: '#24292f',
		gutter: '#f6f8fa',
		gutterText: '#8c959f',
		activeLine: '#f6f8fa',
		activeGutter: '#57606a',
		accent: '#0969da',
		selection: '#b6d7ff',
		heading: '#0550ae',
		link: '#0969da',
		code: '#953800',
		quote: '#57606a',
		punctuation: '#6e7781',
	},
	solarized: {
		dark: true,
		background: '#002b36',
		foreground: '#93a1a1',
		gutter: '#002b36',
		gutterText: '#586e75',
		activeLine: '#073642',
		activeGutter: '#839496',
		accent: '#2aa198',
		selection: '#164e59',
		heading: '#b58900',
		link: '#268bd2',
		code: '#cb4b16',
		quote: '#859900',
		punctuation: '#657b83',
	},
}

function editorExtensions(colorScheme: EditorColorScheme) {
	const palette = EDITOR_PALETTES[colorScheme]
	return [
		EditorView.theme(
			{
				'&': {
					height: '100%',
					backgroundColor: palette.background,
					color: palette.foreground,
					fontSize: '16px',
				},
				'.cm-scroller': {
					fontFamily:
						"'Noto Sans Mono', 'Noto Sans JP', 'SFMono-Regular', Consolas, monospace",
					lineHeight: '1.75',
					padding: '22px 0 80px',
				},
				'.cm-content': {
					padding: '0 28px',
					caretColor: palette.accent,
				},
				'.cm-gutters': {
					backgroundColor: palette.gutter,
					color: palette.gutterText,
					border: 'none',
					paddingLeft: '8px',
				},
				'.cm-activeLine': { backgroundColor: palette.activeLine },
				'.cm-activeLineGutter': {
					backgroundColor: palette.activeLine,
					color: palette.activeGutter,
				},
				'.cm-selectionBackground, ::selection': {
					backgroundColor: `${palette.selection} !important`,
				},
				'.cm-cursor, .cm-dropCursor': {
					borderLeftColor: palette.accent,
				},
				'.cm-focused': { outline: 'none' },
				'.cm-foldPlaceholder': {
					backgroundColor: palette.activeLine,
					border: 'none',
					color: palette.accent,
				},
				'.cm-searchMatch': {
					backgroundColor: `${palette.selection}99`,
					outline: `1px solid ${palette.accent}`,
				},
				'.cm-panels, .cm-tooltip': {
					color: palette.foreground,
					backgroundColor: palette.gutter,
					borderColor: palette.punctuation,
				},
			},
			{ dark: palette.dark },
		),
		syntaxHighlighting(
			HighlightStyle.define([
				{
					tag: [
						tags.heading,
						tags.heading1,
						tags.heading2,
						tags.heading3,
						tags.heading4,
						tags.heading5,
						tags.heading6,
					],
					color: palette.heading,
					fontWeight: '700',
				},
				{ tag: tags.strong, fontWeight: '700' },
				{ tag: tags.emphasis, fontStyle: 'italic' },
				{
					tag: [tags.link, tags.url],
					color: palette.link,
					textDecoration: 'underline',
				},
				{ tag: tags.monospace, color: palette.code },
				{ tag: tags.quote, color: palette.quote, fontStyle: 'italic' },
				{
					tag: [tags.contentSeparator, tags.list, tags.punctuation],
					color: palette.punctuation,
				},
			]),
		),
	]
}

export const MarkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(
	function MarkdownEditor(
		{
			text,
			awareness,
			readOnly = false,
			onPasteImages,
			onScrollProgress,
			onDocumentLimitExceeded,
			colorScheme,
		},
		ref,
	) {
		const parentRef = useRef<HTMLDivElement>(null)
		const viewRef = useRef<EditorView | null>(null)
		const themeCompartmentRef = useRef(new Compartment())
		const initialColorSchemeRef = useRef(colorScheme)

		useEffect(() => {
			if (!parentRef.current) return
			const undoManager = new Y.UndoManager(text)
			let lastLimitNoticeAt = 0
			const state = EditorState.create({
				doc: text.toString(),
				extensions: [
					basicSetup,
					markdown(),
					EditorView.lineWrapping,
					themeCompartmentRef.current.of(
						editorExtensions(initialColorSchemeRef.current),
					),
					EditorState.readOnly.of(readOnly),
					EditorState.transactionFilter.of((transaction) => {
						if (!transaction.docChanged) return transaction
						const nextDocument = transaction.newDoc
						if (nextDocument.length <= Math.floor(MAX_MARKDOWN_BYTES / 3)) {
							return transaction
						}
						if (
							!exceedsUtf8ByteLimit(
								nextDocument.toString(),
								MAX_MARKDOWN_BYTES,
							)
						) return transaction
						const now = Date.now()
						if (now - lastLimitNoticeAt > 1_000) {
							lastLimitNoticeAt = now
							onDocumentLimitExceeded?.()
						}
						return []
					}),
					yCollab(text, awareness, { undoManager }),
					EditorView.domEventHandlers({
						paste(event) {
							if (readOnly || !event.clipboardData || !onPasteImages) {
								return false
							}
							const images = [...event.clipboardData.files].filter((file) =>
								file.type.startsWith('image/'),
							)
							if (!images.length) return false
							event.preventDefault()
							onPasteImages(images)
							return true
						},
					}),
				],
			})
			const view = new EditorView({ state, parent: parentRef.current })
			viewRef.current = view
			let scrollFrame = 0
			const reportScroll = () => {
				window.cancelAnimationFrame(scrollFrame)
				scrollFrame = window.requestAnimationFrame(() => {
					const maximum =
						view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight
					onScrollProgress?.(
						maximum > 0 ? view.scrollDOM.scrollTop / maximum : 0,
					)
				})
			}
			view.scrollDOM.addEventListener('scroll', reportScroll, {
				passive: true,
			})
			return () => {
				window.cancelAnimationFrame(scrollFrame)
				view.scrollDOM.removeEventListener('scroll', reportScroll)
				viewRef.current = null
				view.destroy()
				undoManager.destroy()
			}
		}, [
			awareness,
			onDocumentLimitExceeded,
			onPasteImages,
			onScrollProgress,
			readOnly,
			text,
		])

		useEffect(() => {
			const view = viewRef.current
			if (!view) return
			view.dispatch({
				effects: themeCompartmentRef.current.reconfigure(
					editorExtensions(colorScheme),
				),
			})
		}, [colorScheme])

		useImperativeHandle(
			ref,
			() => ({
				wrapSelection(before: string, after = before) {
					const view = viewRef.current
					if (!view || readOnly) return
					const { from, to } = view.state.selection.main
					const selected = view.state.sliceDoc(from, to)
					view.dispatch({
						changes: { from, to, insert: `${before}${selected}${after}` },
						selection: {
							anchor: from + before.length,
							head: from + before.length + selected.length,
						},
					})
					view.focus()
				},
				insertText(value: string) {
					const view = viewRef.current
					if (!view || readOnly) return
					const { from, to } = view.state.selection.main
					view.dispatch({
						changes: { from, to, insert: value },
						selection: { anchor: from + value.length },
					})
					view.focus()
				},
				scrollToPosition(position: number) {
					const view = viewRef.current
					if (!view) return
					const target = Math.max(
						0,
						Math.min(position, view.state.doc.length),
					)
					view.dispatch({
						effects: EditorView.scrollIntoView(target, {
							y: 'start',
							yMargin: 32,
						}),
					})
				},
				scrollToProgress(progress: number) {
					const view = viewRef.current
					if (!view) return false
					const maximum =
						view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight
					const target =
						Math.max(0, Math.min(progress, 1)) * Math.max(maximum, 0)
					if (Math.abs(view.scrollDOM.scrollTop - target) < 0.5) {
						return false
					}
					view.scrollDOM.scrollTop = target
					return true
				},
				focus() {
					viewRef.current?.focus()
				},
			}),
			[readOnly],
		)

		return <div className="markdown-editor" ref={parentRef} />
	},
)
