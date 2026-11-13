/**
 * チャット入力欄（textarea）のキー判定。
 *
 * 決定（レビュー enter-key-01）:
 *   物理キーボードの **Shift+Enter だけ**が送信。Enter は改行、送信ボタンでも送れる。
 *   シート型のキーボードでは shiftKey が立たないので、改行だけが入る（＝誤送信しない）。
 *
 * IME 変換中の Enter（`isComposing`）は漢字の確定に使うので、送信にしない。
 */
export function shouldSendOnEnter({ key = '', shiftKey = false, isComposing = false } = {}) {
  if (key !== 'Enter') return false
  if (isComposing) return false
  return Boolean(shiftKey)
}
