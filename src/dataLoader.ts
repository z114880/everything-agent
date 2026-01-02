import fs from 'fs/promises';
import { accessSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Data Loader - Reads all user data files
 */
export class DataLoader {
  private dataDir: string;

  constructor(dataDir: string | null = null) {
    // Default to read from device_data directory, if not exists then read from project root
    if (!dataDir) {
      const deviceDataDir = path.join(__dirname, 'device_data');
      // Check if device_data directory exists
      try {
        accessSync(deviceDataDir);
        this.dataDir = deviceDataDir;
      } catch {
        this.dataDir = path.join(__dirname, '..');
      }
    } else {
      this.dataDir = dataDir;
    }
  }

  /**
   * Load user profile file
   */
  async loadUserProfile() {
    const filePath = path.join(this.dataDir, 'user_profile.json');
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  }

  /**
   * Load calendar data
   */
  async loadCalendar() {
    const filePath = path.join(this.dataDir, 'calendar.csv');
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.trim().split('\n');
    const headers = lines[0].split(',');
    
    return lines.slice(1).map(line => {
      const values = line.split(',');
      const event: Record<string, string> = {};
      headers.forEach((header, index) => {
        event[header.trim()] = values[index]?.trim() || '';
      });
      return event;
    });
  }

  /**
   * Load location data
   */
  async loadLocation() {
    const filePath = path.join(this.dataDir, 'location.csv');
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.trim().split('\n');
    const headers = lines[0].split(',');
    
    return lines.slice(1).map(line => {
      const values = line.split(',');
      const location: Record<string, string> = {};
      headers.forEach((header, index) => {
        location[header.trim()] = values[index]?.trim() || '';
      });
      return location;
    });
  }

  /**
   * Load social media data
   */
  async loadSocialMedia() {
    const filePath = path.join(this.dataDir, 'social_media.json');
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  }

  /**
   * Load Spotify playlists
   */
  async loadSpotifyPlaylists() {
    const filePath = path.join(this.dataDir, 'spotify_playlists.json');
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  }

  /**
   * Load all data
   */
  async loadAll() {
    const [profile, calendar, location, socialMedia, spotify] = await Promise.all([
      this.loadUserProfile(),
      this.loadCalendar(),
      this.loadLocation(),
      this.loadSocialMedia(),
      this.loadSpotifyPlaylists()
    ]);

    return {
      profile,
      calendar,
      location,
      socialMedia,
      spotify
    };
  }
}

