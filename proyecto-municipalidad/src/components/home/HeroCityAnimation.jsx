import { m, useMotionValueEvent, useReducedMotion, useScroll, useTransform } from 'framer-motion'
import { useEffect, useRef, useState } from 'react'

const routePath = 'M18 16 C26 26 36 38 48 48 C61 59 74 70 88 84'
const milestoneProgress = [0.03, 0.37, 0.66, 0.9]

const scaleMilestones = [
  { label: '01', title: 'Despegue', className: 'milestone-a' },
  { label: '02', title: 'Expansión', className: 'milestone-b' },
  { label: '03', title: 'Cobertura', className: 'milestone-c' },
  { label: '04', title: 'Escala', className: 'milestone-d' },
]

function HeroCityAnimation() {
  const stageRef = useRef(null)
  const pathRef = useRef(null)
  const [activeStep, setActiveStep] = useState(1)
  const [truckPose, setTruckPose] = useState({ x: 18, y: 16, angle: 40 })
  const [milestonePositions, setMilestonePositions] = useState(
    scaleMilestones.map((_, index) => ({ x: 18 + index * 20, y: 16 + index * 20 })),
  )
  const shouldReduceMotion = useReducedMotion()
  const { scrollYProgress } = useScroll({
    target: stageRef,
    offset: ['start start', 'end end'],
  })
  const routeProgress = useTransform(scrollYProgress, [0.08, 0.84], [0, 1])

  const truckScale = useTransform(routeProgress, [0, 0.4, 0.75, 1], [0.94, 1.03, 1, 0.97])
  const routeDraw = useTransform(routeProgress, [0, 1], [0, 1])
  const titleShift = useTransform(scrollYProgress, [0, 1], ['0px', '-12px'])
  const stepOpacities = [
    useTransform(routeProgress, [0.08, 0.16], [0, 1]),
    useTransform(routeProgress, [0.3, 0.38], [0, 1]),
    useTransform(routeProgress, [0.54, 0.62], [0, 1]),
    useTransform(routeProgress, [0.76, 0.84], [0, 1]),
  ]
  const stepScales = [
    useTransform(routeProgress, [0.08, 0.16], [0.86, 1]),
    useTransform(routeProgress, [0.3, 0.38], [0.86, 1]),
    useTransform(routeProgress, [0.54, 0.62], [0.86, 1]),
    useTransform(routeProgress, [0.76, 0.84], [0.86, 1]),
  ]

  useEffect(() => {
    const path = pathRef.current
    if (!path) return

    const totalLength = path.getTotalLength()
    const nextPositions = milestoneProgress.map((progress) => {
      const point = path.getPointAtLength(totalLength * progress)
      return { x: point.x, y: point.y }
    })

    setMilestonePositions(nextPositions)
  }, [])

  useMotionValueEvent(routeProgress, 'change', (latest) => {
    const path = pathRef.current
    if (path) {
      const totalLength = path.getTotalLength()
      const currentLength = totalLength * latest
      const currentPoint = path.getPointAtLength(currentLength)
      const nextPoint = path.getPointAtLength(Math.min(totalLength, currentLength + 1.2))
      const mapBox = path.closest('.hero-city-map')?.getBoundingClientRect()
      const scaleX = mapBox ? mapBox.width / 100 : 1
      const scaleY = mapBox ? mapBox.height / 100 : 1
      const angle = Math.atan2(
        (nextPoint.y - currentPoint.y) * scaleY,
        (nextPoint.x - currentPoint.x) * scaleX,
      ) * (180 / Math.PI)
      setTruckPose({ x: currentPoint.x, y: currentPoint.y, angle })
    }

    const nextStep = latest < 0.25 ? 1 : latest < 0.5 ? 2 : latest < 0.75 ? 3 : 4
    setActiveStep(nextStep)
  })

  return (
    <section className="hero-city-animation" ref={stageRef} aria-label="Escalamiento municipal animado por scroll">
      <div className="hero-city-sticky">
        <div className="hero-city-stage" aria-hidden="true">
          <m.div className="hero-city-copy hero-city-copy-inside" style={shouldReduceMotion ? undefined : { y: titleShift }}>
            <span className="hero-city-kicker">Expansión municipal</span>
            <h2>Próximamente en más ciudades</h2>
            <p>Vamos escalando paso a paso con cada nuevo tramo del recorrido.</p>
          </m.div>

          <div className="hero-city-map">
            <svg className="city-route-line" viewBox="0 0 100 100" preserveAspectRatio="none">
              <path ref={pathRef} className="city-route-measure" d={routePath} />
              <path className="city-route-shadow" d={routePath} />
              <m.path className="city-route-progress" d={routePath} pathLength={routeDraw} />
            </svg>

            {scaleMilestones.map((step, index) => (
              <m.div
                className={`city-scale-milestone ${step.className}`}
                key={step.label}
                style={{
                  left: `${milestonePositions[index]?.x ?? 18}%`,
                  top: `${milestonePositions[index]?.y ?? 16}%`,
                  x: '-50%',
                  y: '-68%',
                  ...(shouldReduceMotion
                    ? {}
                    : {
                        opacity: stepOpacities[index],
                        scale: stepScales[index],
                      }),
                }}
              >
                <strong>{step.label}</strong>
                <span>{step.title}</span>
              </m.div>
            ))}

            <m.div
              className="hero-trash-truck"
              style={
                shouldReduceMotion
                  ? undefined
                  : {
                      left: `${truckPose.x}%`,
                      top: `${truckPose.y}%`,
                      x: '-50%',
                      y: '-64%',
                      rotate: truckPose.angle,
                      scale: truckScale,
                    }
              }
            >
              <span className="hero-trash-truck-loader" />
              <span className="hero-trash-truck-box">
                <span className="hero-trash-truck-stripe" />
                <span className="hero-trash-truck-light" />
              </span>
              <span className="hero-trash-truck-cab">
                <span className="hero-trash-truck-window" />
              </span>
              <span className="hero-trash-truck-wheel wheel-a" />
              <span className="hero-trash-truck-wheel wheel-b" />
            </m.div>
          </div>

          <div className="hero-city-hud">
            <strong>{activeStep}</strong>
            <span>niveles de expansión</span>
          </div>
        </div>
      </div>
    </section>
  )
}

export default HeroCityAnimation
