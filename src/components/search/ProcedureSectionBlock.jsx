function ProcedureSectionBlock({ title, content }) {
  const normalized = Array.isArray(content) ? content.filter(Boolean) : [content].filter(Boolean)
  if (!normalized.length) return null

  return (
    <div className="result-block">
      <strong>{title}</strong>
      {normalized.length > 1 ? (
        <ul>
          {normalized.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : (
        <p>{normalized[0]}</p>
      )}
    </div>
  )
}

export default ProcedureSectionBlock
