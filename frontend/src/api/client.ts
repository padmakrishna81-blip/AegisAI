import axios from 'axios'

const client = axios.create({
  baseURL: 'http://localhost:8001/api',
  timeout: 60000,
  headers: { 'Content-Type': 'application/json' },
})

// Attach JWT token to every request
client.interceptors.request.use((config) => {
  const token = localStorage.getItem('aegis_token')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

// Redirect to login on 401
client.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem('aegis_token')
      localStorage.removeItem('aegis_user')
      window.location.href = '/login'
    }
    return Promise.reject(err)
  }
)

export default client
