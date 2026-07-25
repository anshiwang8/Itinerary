import type { Metadata } from "next";
import "@fontsource-variable/fraunces";
import "@fontsource-variable/space-grotesk";
import "./globals.css";

export const metadata: Metadata = {
  title: "Itinerary — life moves simpler.",
  description: "Plan your day, weather included.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
