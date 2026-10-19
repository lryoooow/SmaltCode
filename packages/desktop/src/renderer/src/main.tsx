import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

class InterfaceBoundary extends React.Component<React.PropsWithChildren, { error: boolean }> {
  state = { error: false }
  static getDerivedStateFromError() { return { error: true } }
  render() {
    if (this.state.error) return <div role="alert" className="h-screen grid place-items-center bg-[#17191f] text-white p-8"><div><h1 className="text-xl font-semibold">界面遇到错误</h1><p className="mt-3 text-sm text-gray-300">请通过托盘退出并重新打开 SmaltCode。已有对话会保留，重启后可检查未完成任务。</p></div></div>
    return this.props.children
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <InterfaceBoundary><App /></InterfaceBoundary>
  </React.StrictMode>,
)
