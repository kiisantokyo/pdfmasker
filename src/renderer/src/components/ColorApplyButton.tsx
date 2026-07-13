import { useEffect, useRef, useState } from 'react'
import type { ColorChoice } from '../lib/colors'
import { cssColor } from '../lib/colors'

interface Props {
  /** Button label, e.g. 「墨消し」. */
  label: string
  /** Count shown in the badge (pending marks). */
  count: number
  disabled: boolean
  colors: ColorChoice[]
  selected: ColorChoice
  onSelect: (c: ColorChoice) => void
  onApply: () => void
  /** Extra class for the apply button (colour theming). */
  applyClass?: string
  title?: string
}

/**
 * Split button: a colour swatch + ▾ opens a palette; the main body applies the
 * action in the currently selected colour. Used for 墨消し and マーカー.
 */
export default function ColorApplyButton({
  label,
  count,
  disabled,
  colors,
  selected,
  onSelect,
  onApply,
  applyClass = '',
  title
}: Props): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  return (
    <div className="split-btn" ref={ref}>
      <button
        className="split-swatch"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        title="色を選ぶ"
      >
        <span
          className="swatch"
          style={{ background: cssColor(selected.rgb) }}
        />
        <span className="caret">▾</span>
      </button>
      <button
        className={'split-apply ' + applyClass}
        onClick={onApply}
        disabled={disabled || count === 0}
        title={title}
      >
        {label}
        <span className="act-count">{count}</span>
      </button>
      {open && (
        <div className="color-menu">
          {colors.map((c) => (
            <button
              key={c.key}
              className={'color-item' + (c.key === selected.key ? ' sel' : '')}
              onClick={() => {
                onSelect(c)
                setOpen(false)
              }}
            >
              <span
                className={'swatch' + (c.rgb ? '' : ' whiteout')}
                style={{ background: cssColor(c.rgb) }}
              />
              {c.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
