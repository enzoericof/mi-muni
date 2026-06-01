import { useEffect, useRef, useState } from 'react'

function RevealSection({ children, className = '', as: Tag = 'section', ...rest }) {
  const ref = useRef(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const node = ref.current
    if (!node) return undefined

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setVisible(true)
      },
      { threshold: 0.16 },
    )

    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const composedClassName = `reveal-section ${visible ? 'is-visible' : ''} ${className}`.trim()

  return (
    <Tag ref={ref} className={composedClassName} {...rest}>
      {children}
    </Tag>
  )
}

export default RevealSection
