# RiftCoach – League of Legends Performance Analytics Platform

## Overview

RiftCoach is a League of Legends analytics and coaching platform designed to turn player match data into meaningful insights. It combines real-time data ingestion, AI-assisted analysis, and clear visualizations to help players understand their performance, spot strengths and weaknesses, and explore personalized recommendations.

## Architecture Overview

### Frontend Web Application

The web interface, built with React, provides an intuitive dashboard where players can:

- Scan and track their match history in real time
- View AI-generated playstyle badges and insights
- Explore detailed match breakdowns and champion analytics
- Access build and itemization recommendations
- Share personalized performance cards

The frontend uses modern tools such as TanStack Router for navigation, Tailwind CSS for styling, and shadcn/ui for a cohesive UI experience. Real-time WebSocket connections keep users updated on scan progress and data availability.

### Backend API Services

A Hono-based API powers the platform’s data processing and business logic, including:

- **Queue Management**: BullMQ queues grouped by region (Americas, Europe, Asia, SEA, Esports) to handle match ingestion efficiently
- **Riot API Integration**: A custom rate-limited client with retry logic for stable data retrieval
- **Live Updates**: WebSocket events for scan progress and insight delivery
- **Data Aggregation**: Optimized MongoDB aggregations for player and champion performance metrics

### Data Processing Pipeline

#### Match Ingestion

Match data flows through several processing stages:

1. **Listing**: Finds all matches linked to a player account
2. **Fetching**: Retrieves detailed information from Riot APIs
3. **Timeline Analysis**: Processes in-game events for granular context
4. **Data Enrichment**: Adds metadata about champions, items, and roles

#### AI-Assisted Analysis

Using AWS Bedrock, RiftCoach adds intelligent coaching and analysis features:

- **Match Insights**: Summaries of notable moments and decisions
- **Playstyle Analysis**: Identification of consistent strengths and focus areas
- **Build Recommendations**: Itemization suggestions informed by performance and meta trends
- **Badge System**: AI-generated badges reflecting distinctive play patterns

### Data Storage & Management

#### MongoDB

- Stores raw and processed match data
- Supports statistical queries and aggregations
- Maintains historical player records and performance trends

#### Redis

- Manages API rate limits and caching
- Tracks live scan progress
- Coordinates distributed queue operations for scalability

#### Data Dragon Integration

- Provides static game metadata (champions, items, runes)
- Supports localization for multiple regions
- Supplies contextual data for AI processing

## Key Features

### Year-in-Review Analytics

Annual summaries that showcase:

- Champion mastery and role evolution
- Win rate and performance trends over time
- Comparisons with similar player cohorts
- Seasonal highlights and improvements

### Real-Time Match Analysis

Per-match insights include:

- Lane opponent comparisons and matchup context
- Key moments and decision-making breakdowns
- Build path and macro play suggestions

### Professional Player Support

Tools designed with competitive play in mind:

- Verified pro-player profiles
- Team and tournament analytics
- Scouting and preparation utilities

### Statistical Modeling

Advanced analytics covering:

- Normalized percentile metrics for roles and champions
- Build frequency and win-rate correlations
- Champion synergy and counter statistics

## Getting Started

### Prerequisites

- Node.js (v24)
- pnpm
- MongoDB instance
- Redis instance
- AWS account with Bedrock access
- Riot API key

### Run

- Install dependencies: `pnpm install`
- Set up environment variables:
  - Copy `.env.example` to `.env`
  - Fill in your MongoDB, Redis, AWS, and Riot API credentials
- Start each server:
  - API: `pnpm dev:api`
  - Frontend: `pnpm dev:web`
