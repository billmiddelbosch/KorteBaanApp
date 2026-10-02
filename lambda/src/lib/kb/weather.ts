// Daily weather at the baan from Open-Meteo (free, no key). Dates older than ~2 months come
// from the ERA5 archive; recent dates from the forecast API, which also serves the past weeks.
import type { Weather } from './store'

const DAILY = 'temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,weather_code'
const ARCHIVE_AFTER_DAYS = 60

export function weatherUrl(lat: number, lon: number, date: string, today: string): string {
  const age = (Date.parse(today) - Date.parse(date)) / 86_400_000
  const base = age > ARCHIVE_AFTER_DAYS ? 'https://archive-api.open-meteo.com/v1/archive' : 'https://api.open-meteo.com/v1/forecast'
  const q = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    start_date: date,
    end_date: date,
    daily: DAILY,
    timezone: 'Europe/Amsterdam',
  })
  return `${base}?${q}`
}

interface OpenMeteoDaily {
  daily?: {
    time?: string[]
    temperature_2m_max?: (number | null)[]
    temperature_2m_min?: (number | null)[]
    precipitation_sum?: (number | null)[]
    wind_speed_10m_max?: (number | null)[]
    weather_code?: (number | null)[]
  }
}

export function parseWeather(json: OpenMeteoDaily, date: string, sourceUrl: string): Weather | null {
  const d = json.daily
  const i = d?.time?.indexOf(date) ?? -1
  if (!d || i < 0) return null
  const w: Weather = {
    tempMax: d.temperature_2m_max?.[i] ?? null,
    tempMin: d.temperature_2m_min?.[i] ?? null,
    neerslagMm: d.precipitation_sum?.[i] ?? null,
    windKmh: d.wind_speed_10m_max?.[i] ?? null,
    weercode: d.weather_code?.[i] ?? null,
    sourceUrl,
  }
  return w.tempMax === null && w.neerslagMm === null ? null : w
}

export async function fetchWeather(lat: number, lon: number, date: string, today: string): Promise<Weather | null> {
  const url = weatherUrl(lat, lon, date, today)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Open-Meteo: HTTP ${res.status}`)
  return parseWeather((await res.json()) as OpenMeteoDaily, date, url)
}
