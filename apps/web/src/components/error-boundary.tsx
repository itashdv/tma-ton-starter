'use client'

import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  fallback: ReactNode
  children: ReactNode
  onError?: (error: Error, info: ErrorInfo) => void
}

interface State {
  failed: boolean
}

/**
 * The Telegram SDK reads the launch environment and can throw on an old client or on
 * unexpected launch parameters. Without a boundary React unmounts the whole tree and the user
 * sees a blank page; here they get the same "open from Telegram" panel instead.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false }

  static getDerivedStateFromError(): State {
    return { failed: true }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.(error, info)
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}
