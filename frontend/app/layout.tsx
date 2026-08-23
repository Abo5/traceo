import type { Metadata } from "next";
import "./globals.css";
import Providers from "@/components/providers";

export const metadata: Metadata = {
  title: "Traceo — trace requirements to executed tests",
  description:
    "Traceo — from requirement to executed test: parse requirements, ground test generation in the API inventory, review, execute and trace.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" dir="ltr">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body data-testid="nav-app-root">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
