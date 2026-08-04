import { useTheme } from "../context/ThemeContext";
import Navbar from "../components/Navbar";
import CursorGlow from "../components/landing/CursorGlow";
import Hero from "../components/landing/Hero";
import LogoMarquee from "../components/landing/LogoMarquee";
import Features from "../components/landing/Features";
import ModelsShowcase from "../components/landing/ModelsShowcase";
import WhyTimeline from "../components/landing/WhyTimeline";
import ArchitectureFlow from "../components/landing/ArchitectureFlow";
import DeveloperSection from "../components/landing/DeveloperSection";
import SiteFooter from "../components/landing/SiteFooter";

export default function HomePage() {
  const { isDark, toggleTheme } = useTheme();

  return (
    <div className="landing">
      {/* ambient background layers */}
      <div className="aurora" aria-hidden="true" />
      <div className="mesh" aria-hidden="true" />
      <div className="noise" aria-hidden="true" />
      <CursorGlow />

      <div className="landing-content">
        <Navbar isDark={isDark} toggleTheme={toggleTheme} />
        <Hero isDark={isDark} />
        <LogoMarquee />
        <Features />
        <ModelsShowcase />
        <WhyTimeline />
        <ArchitectureFlow />
        <DeveloperSection />
        <SiteFooter />
      </div>
    </div>
  );
}
