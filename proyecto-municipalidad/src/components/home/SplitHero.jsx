import { LazyMotion, domAnimation, m, useReducedMotion } from 'framer-motion'
import { useAppContext } from '../../lib/AppContext'
import HeroChat from './HeroChat'
import HeroCityAnimation from './HeroCityAnimation'
import HeroMiniMap from './HeroMiniMap'
import HeroPotholes from './HeroPotholes'

function SplitHero() {
  const shouldReduceMotion = useReducedMotion()
  const { municipality } = useAppContext()

  const containerVariants = {
    hidden: {},
    show: {
      transition: {
        staggerChildren: shouldReduceMotion ? 0 : 0.12,
        delayChildren: shouldReduceMotion ? 0 : 0.04,
      },
    },
  }

  const itemVariants = {
    hidden: shouldReduceMotion ? { opacity: 1 } : { opacity: 0, scale: 0.985 },
    show: {
      opacity: 1,
      scale: 1,
      transition: {
        duration: 0.42,
        ease: [0.22, 1, 0.36, 1],
      },
    },
  }

  return (
    <LazyMotion features={domAnimation}>
      <m.section
        className="split-hero"
        variants={containerVariants}
        initial="hidden"
        animate="show"
      >
        <div className="split-hero-top">
          <m.div className="split-hero-header" variants={itemVariants}>
            <span className="eyebrow section-pill">Bienvenido a Mi Muni</span>
            <h1>
              <span>Todo</span> <em>{municipality?.label || 'Asunci\u00f3n'}</em> <span>en un solo lugar.</span>
            </h1>
          </m.div>
        </div>

        <m.div variants={itemVariants}>
          <HeroChat />
        </m.div>

        <div className="split-hero-grid">
          <m.div className="hero-motion-card" variants={itemVariants} whileHover={shouldReduceMotion ? undefined : { y: -4 }}>
            <HeroPotholes />
          </m.div>
          <m.div className="hero-motion-card" variants={itemVariants} whileHover={shouldReduceMotion ? undefined : { y: -4 }}>
            <HeroMiniMap />
          </m.div>
        </div>

        <m.div className="split-hero-visual" variants={itemVariants}>
          <HeroCityAnimation />
        </m.div>
      </m.section>
    </LazyMotion>
  )
}

export default SplitHero
