const STORAGE_KEY = 'mimuni:guest'
const APP_TIME_ZONE = 'America/Asuncion'

const defaultState = {
  dayKey: '',
  questionCount: 0,
}

function getDayKey() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

function readStorage() {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch (_error) {
    return null
  }
}

export function load() {
  const todayKey = getDayKey()
  const storage = readStorage()
  if (!storage) return { ...defaultState, dayKey: todayKey }

  const raw = storage.getItem(STORAGE_KEY)
  if (!raw) return { ...defaultState, dayKey: todayKey }

  try {
    const parsed = JSON.parse(raw)
    if (parsed?.dayKey !== todayKey) {
      return { ...defaultState, dayKey: todayKey }
    }
    return {
      dayKey: todayKey,
      questionCount: Number.isFinite(parsed?.questionCount) ? parsed.questionCount : 0,
    }
  } catch (_error) {
    return { ...defaultState, dayKey: todayKey }
  }
}

function save(state) {
  const storage = readStorage()
  if (!storage) return
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch (_error) {
    // noop
  }
}

export function increment() {
  const current = load()
  const next = { ...current, dayKey: getDayKey(), questionCount: current.questionCount + 1 }
  save(next)
  return next
}

export function reset() {
  const next = { ...defaultState, dayKey: getDayKey() }
  save(next)
  return next
}
