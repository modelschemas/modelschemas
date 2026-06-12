/**
 * Generative UI: a form rendered entirely from a JSON Schema at render time.
 * No component here knows anything about any particular provider — controls
 * are chosen from schema keywords (enum, type, bounds, anyOf/oneOf, $defs).
 */
import { useId, useState } from 'react'
import {
  asJsonValue,
  enumValues,
  isJsonObject,
  matchVariant,
  num,
  obj,
  properties,
  requiredNames,
  resolveRef,
  schemaLabel,
  schemaType,
  seedValue,
  str,
  variants,
} from '../lib/jsonschema'
import type { JsonObject, JsonValue, SchemaNode } from '../lib/jsonschema'

const MAX_DEPTH = 9

interface ControlProps {
  schema: SchemaNode
  root: SchemaNode
  value: JsonValue | undefined
  onChange: (value: JsonValue) => void
  depth: number
}

export function SchemaForm({
  schema,
  value,
  onChange,
}: {
  schema: SchemaNode
  value: JsonValue
  onChange: (value: JsonValue) => void
}) {
  return (
    <SchemaControl
      schema={schema}
      root={schema}
      value={value}
      onChange={onChange}
      depth={0}
    />
  )
}

function SchemaControl(props: ControlProps) {
  const { root, value, onChange, depth } = props
  const schema = resolveRef(props.schema, root)

  if (depth > MAX_DEPTH) {
    return <RawJsonControl value={value} onChange={onChange} />
  }

  const constant = asJsonValue(schema['const'])
  if (constant !== undefined && enumValues(schema) === undefined) {
    return <ConstBadge value={constant} />
  }

  const options = enumValues(schema)
  if (options !== undefined) {
    return <EnumControl options={options} value={value} onChange={onChange} />
  }

  const variantList = variants(schema, root)
  if (variantList !== undefined) {
    if (variantList.length === 1 && variantList[0] !== undefined) {
      return (
        <SchemaControl
          schema={variantList[0]}
          root={root}
          value={value}
          onChange={onChange}
          depth={depth}
        />
      )
    }
    return (
      <VariantControl
        root={root}
        value={value}
        onChange={onChange}
        depth={depth}
        variantList={variantList}
      />
    )
  }

  switch (schemaType(schema)) {
    case 'boolean':
      return <BooleanControl value={value} onChange={onChange} />
    case 'integer':
    case 'number':
      return (
        <NumberControl
          schema={schema}
          value={value}
          onChange={onChange}
          integer={schemaType(schema) === 'integer'}
        />
      )
    case 'string':
      return <StringControl schema={schema} value={value} onChange={onChange} />
    case 'array':
      return (
        <ArrayControl
          schema={schema}
          root={root}
          value={value}
          onChange={onChange}
          depth={depth}
        />
      )
    case 'object':
      return (
        <ObjectControl
          schema={schema}
          root={root}
          value={value}
          onChange={onChange}
          depth={depth}
        />
      )
    default:
      return <RawJsonControl value={value} onChange={onChange} />
  }
}

function ConstBadge({ value }: { value: JsonValue }) {
  return (
    <span className="const-badge" title="fixed by the schema (const)">
      {typeof value === 'string' ? value : JSON.stringify(value)}
    </span>
  )
}

function EnumControl({
  options,
  value,
  onChange,
}: {
  options: Array<JsonValue>
  value: JsonValue | undefined
  onChange: (value: JsonValue) => void
}) {
  const asLabel = (option: JsonValue) =>
    typeof option === 'string' ? option : JSON.stringify(option)
  if (options.length <= 6) {
    return (
      <div className="chip-row" role="radiogroup">
        {options.map((option) => (
          <button
            key={asLabel(option)}
            type="button"
            role="radio"
            aria-checked={value === option}
            className={value === option ? 'chip chip-on' : 'chip'}
            onClick={() => onChange(option)}
          >
            {asLabel(option)}
          </button>
        ))}
      </div>
    )
  }
  const selected = options.findIndex((option) => option === value)
  return (
    <select
      className="field-input"
      value={selected === -1 ? '' : String(selected)}
      onChange={(event) => {
        const next = options[Number(event.target.value)]
        if (next !== undefined) onChange(next)
      }}
    >
      {selected === -1 && <option value="">— choose —</option>}
      {options.map((option, index) => (
        <option key={asLabel(option)} value={String(index)}>
          {asLabel(option)}
        </option>
      ))}
    </select>
  )
}

function BooleanControl({
  value,
  onChange,
}: {
  value: JsonValue | undefined
  onChange: (value: JsonValue) => void
}) {
  const on = value === true
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className={on ? 'toggle toggle-on' : 'toggle'}
      onClick={() => onChange(!on)}
    >
      <span className="toggle-thumb" />
      <span className="toggle-text">{on ? 'true' : 'false'}</span>
    </button>
  )
}

function NumberControl({
  schema,
  value,
  onChange,
  integer,
}: {
  schema: SchemaNode
  value: JsonValue | undefined
  onChange: (value: JsonValue) => void
  integer: boolean
}) {
  const min = num(schema, 'minimum')
  const max = num(schema, 'maximum')
  const current = typeof value === 'number' ? value : (min ?? 0)
  const parse = (text: string) => {
    const parsed = integer ? parseInt(text, 10) : parseFloat(text)
    if (!Number.isNaN(parsed)) onChange(parsed)
  }
  if (min !== undefined && max !== undefined && max > min) {
    const step = integer ? 1 : (max - min) / 100
    return (
      <div className="number-rail">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={current}
          onChange={(event) => parse(event.target.value)}
        />
        <input
          type="number"
          className="field-input number-readout"
          min={min}
          max={max}
          step={step}
          value={current}
          onChange={(event) => parse(event.target.value)}
        />
      </div>
    )
  }
  return (
    <input
      type="number"
      className="field-input number-readout"
      min={min}
      max={max}
      value={typeof value === 'number' ? value : ''}
      onChange={(event) => parse(event.target.value)}
    />
  )
}

const LONG_TEXT_HINT = /prompt|content|text|message|instruction|description/i

function StringControl({
  schema,
  value,
  onChange,
}: {
  schema: SchemaNode
  value: JsonValue | undefined
  onChange: (value: JsonValue) => void
}) {
  const text = typeof value === 'string' ? value : ''
  const title = str(schema, 'title') ?? str(schema, 'description') ?? ''
  const long =
    (num(schema, 'maxLength') ?? 0) > 160 || LONG_TEXT_HINT.test(title)
  if (long) {
    return (
      <textarea
        className="field-input field-textarea"
        rows={3}
        value={text}
        placeholder={str(schema, 'example')}
        onChange={(event) => onChange(event.target.value)}
      />
    )
  }
  return (
    <input
      type={str(schema, 'format') === 'uri' ? 'url' : 'text'}
      className="field-input"
      value={text}
      placeholder={str(schema, 'example') ?? str(schema, 'format')}
      onChange={(event) => onChange(event.target.value)}
    />
  )
}

function VariantControl({
  root,
  value,
  onChange,
  depth,
  variantList,
}: Omit<ControlProps, 'schema'> & { variantList: Array<SchemaNode> }) {
  const [picked, setPicked] = useState(() => matchVariant(value, variantList))
  const active = variantList[Math.min(picked, variantList.length - 1)]
  return (
    <div className="variant">
      <div className="variant-tabs" role="tablist">
        {variantList.map((variant, index) => (
          <button
            key={index}
            type="button"
            role="tab"
            aria-selected={index === picked}
            className={index === picked ? 'tab tab-on' : 'tab'}
            onClick={() => {
              setPicked(index)
              onChange(seedValue(variant, root))
            }}
          >
            {schemaLabel(variant, `option ${String(index + 1)}`)}
          </button>
        ))}
      </div>
      {active !== undefined && (
        <SchemaControl
          schema={active}
          root={root}
          value={value}
          onChange={onChange}
          depth={depth + 1}
        />
      )}
    </div>
  )
}

function ArrayControl({ schema, root, value, onChange, depth }: ControlProps) {
  const items = obj(schema, 'items')
  const list = Array.isArray(value) ? value : []
  const setIndex = (index: number, next: JsonValue) => {
    const copy = [...list]
    copy[index] = next
    onChange(copy)
  }
  return (
    <div className="array-box">
      {list.map((item, index) => (
        <div className="array-row" key={index}>
          <span className="array-index">{index}</span>
          <div className="array-item">
            {items !== undefined ? (
              <SchemaControl
                schema={items}
                root={root}
                value={item}
                onChange={(next) => setIndex(index, next)}
                depth={depth + 1}
              />
            ) : (
              <RawJsonControl
                value={item}
                onChange={(next) => setIndex(index, next)}
              />
            )}
          </div>
          <button
            type="button"
            className="ghost-button"
            aria-label={`remove item ${String(index)}`}
            onClick={() => onChange(list.filter((_, at) => at !== index))}
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        className="add-button"
        onClick={() =>
          onChange([
            ...list,
            items !== undefined ? seedValue(items, root) : null,
          ])
        }
      >
        + add {items !== undefined ? schemaLabel(items, 'item') : 'item'}
      </button>
    </div>
  )
}

function ObjectControl({ schema, root, value, onChange, depth }: ControlProps) {
  const record: JsonObject = isJsonObject(value) ? value : {}
  const required = requiredNames(schema)
  const props = properties(schema)
  const present = props.filter(([name]) => required.has(name) || name in record)
  const absent = props.filter(
    ([name]) => !required.has(name) && !(name in record),
  )
  const setProp = (name: string, next: JsonValue) => {
    onChange({ ...record, [name]: next })
  }
  const dropProp = (name: string) => {
    const { [name]: _, ...rest } = record
    onChange(rest)
  }
  return (
    <div className={depth === 0 ? 'object-root' : 'object-box'}>
      {present.map(([name, prop]) => {
        const resolved = resolveRef(prop, root)
        return (
          <Field
            key={name}
            name={name}
            required={required.has(name)}
            description={str(resolved, 'description')}
            onRemove={required.has(name) ? undefined : () => dropProp(name)}
          >
            <SchemaControl
              schema={prop}
              root={root}
              value={record[name]}
              onChange={(next) => setProp(name, next)}
              depth={depth + 1}
            />
          </Field>
        )
      })}
      {absent.length > 0 && (
        <div className="optional-row">
          {absent.map(([name, prop]) => (
            <button
              key={name}
              type="button"
              className="optional-chip"
              title={str(resolveRef(prop, root), 'description')}
              onClick={() => setProp(name, seedValue(prop, root))}
            >
              + {name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function Field({
  name,
  required,
  description,
  onRemove,
  children,
}: {
  name: string
  required: boolean
  description: string | undefined
  onRemove: (() => void) | undefined
  children: React.ReactNode
}) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const blurb = description?.split(/\n/, 1)[0]
  return (
    <div className="field" data-required={required}>
      <div className="field-head">
        <label htmlFor={id} className="field-name">
          {name}
          {required && <span className="field-req">*</span>}
        </label>
        {blurb !== undefined && blurb.length > 0 && (
          <button
            type="button"
            className="field-hint-toggle"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            ?
          </button>
        )}
        {onRemove !== undefined && (
          <button
            type="button"
            className="ghost-button"
            aria-label={`remove ${name}`}
            onClick={onRemove}
          >
            ×
          </button>
        )}
      </div>
      {open && blurb !== undefined && <p className="field-hint">{blurb}</p>}
      <div id={id}>{children}</div>
    </div>
  )
}

function RawJsonControl({
  value,
  onChange,
}: {
  value: JsonValue | undefined
  onChange: (value: JsonValue) => void
}) {
  const [draft, setDraft] = useState(() =>
    JSON.stringify(value ?? null, null, 2),
  )
  const [bad, setBad] = useState(false)
  return (
    <textarea
      className={
        bad
          ? 'field-input field-textarea json-bad'
          : 'field-input field-textarea'
      }
      rows={4}
      spellCheck={false}
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value)
        try {
          const parsed = asJsonValue(JSON.parse(event.target.value))
          if (parsed !== undefined) {
            onChange(parsed)
            setBad(false)
          }
        } catch {
          setBad(true)
        }
      }}
    />
  )
}

/** Pretty, colorized read-only JSON tree for the payload pane. */
export function JsonView({ value }: { value: JsonValue }) {
  return <pre className="json-view">{renderJson(value, 0)}</pre>
}

function renderJson(value: JsonValue, indent: number): React.ReactNode {
  const pad = '  '.repeat(indent)
  const inner = '  '.repeat(indent + 1)
  if (value === null) return <span className="j-null">null</span>
  if (typeof value === 'string')
    return <span className="j-str">{JSON.stringify(value)}</span>
  if (typeof value === 'number')
    return <span className="j-num">{String(value)}</span>
  if (typeof value === 'boolean')
    return <span className="j-bool">{String(value)}</span>
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    return (
      <>
        {'[\n'}
        {value.map((item, index) => (
          <span key={index}>
            {inner}
            {renderJson(item, indent + 1)}
            {index < value.length - 1 ? ',' : ''}
            {'\n'}
          </span>
        ))}
        {pad}
        {']'}
      </>
    )
  }
  const entries = Object.entries(value)
  if (entries.length === 0) return '{}'
  return (
    <>
      {'{\n'}
      {entries.map(([key, item], index) => (
        <span key={key}>
          {inner}
          <span className="j-key">{JSON.stringify(key)}</span>
          {': '}
          {renderJson(item, indent + 1)}
          {index < entries.length - 1 ? ',' : ''}
          {'\n'}
        </span>
      ))}
      {pad}
      {'}'}
    </>
  )
}
