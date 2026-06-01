import { useEffect, useRef, useState } from 'react'

const LEAVE_MS = 180
const ENTER_MS = 220

function RouteTransition({ routeKey, children }) {
  const [phase, setPhase] = useState('entering')
  const [renderedKey, setRenderedKey] = useState(routeKey)
  const [renderedChildren, setRenderedChildren] = useState(children)
  const leaveTimerRef = useRef(null)
  const enterTimerRef = useRef(null)

  useEffect(() => {
    if (routeKey === renderedKey) {
      // misma ruta, solo refrescar contenido sin animar
      setRenderedChildren(children)
      return undefined
    }

    setPhase('leaving')
    if (leaveTimerRef.current) window.clearTimeout(leaveTimerRef.current)
    if (enterTimerRef.current) window.clearTimeout(enterTimerRef.current)

    leaveTimerRef.current = window.setTimeout(() => {
      setRenderedKey(routeKey)
      setRenderedChildren(children)
      setPhase('entering')

      enterTimerRef.current = window.setTimeout(() => {
        setPhase('idle')
      }, ENTER_MS)
    }, LEAVE_MS)

    return () => {
      if (leaveTimerRef.current) window.clearTimeout(leaveTimerRef.current)
      if (enterTimerRef.current) window.clearTimeout(enterTimerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey])

  // si los children cambian dentro del mismo route, mantener actualizado
  useEffect(() => {
    if (routeKey === renderedKey) {
      setRenderedChildren(children)
    }
  }, [children, routeKey, renderedKey])

  return (
    <div className={`route-transition route-${phase}`}>
      {renderedChildren}
    </div>
  )
}

export default RouteTransition
