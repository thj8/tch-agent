import "@fontsource-variable/inter"
import "@fontsource-variable/jetbrains-mono"
import { createRoot } from "react-dom/client"
import { App } from "./app"

const link = document.createElement("link")
link.rel = "stylesheet"
link.href = "/tailwind.css"
document.head.appendChild(link)

const root = document.getElementById("root")
if (!root) throw new Error("root element not found")

createRoot(root).render(<App />)
