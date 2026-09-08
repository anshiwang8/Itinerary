import type { Metadata, Viewport } from "next";
import "@fontsource-variable/fraunces";
import "@fontsource-variable/space-grotesk";
import "./globals.css";
import "./desktopItinerary.css";
import "./mobileItinerary.css";
import "./uiLayout.css";

export const metadata: Metadata = {
  title: "Itinerary: time to leave.",
  description: "Plan your day, weather included.",
};


export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
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
