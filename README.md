# RiftCoach - League of Legends Performance Analytics Platform

## Overview
RiftCoach is an advanced League of Legends coaching and analytics platform that transforms player match data into actionable insights. The system combines real-time data ingestion, AI-powered analysis, and comprehensive visualizations to help players understand their performance, identify strengths and weaknesses, and receive personalized coaching recommendations.

## Architecture Overview

### Frontend Web Application
The React-based web interface provides players with an intuitive dashboard to:
- Initiate match history scans and track progress in real-time
- View AI-generated performance badges and playstyle insights
- Explore detailed match breakdowns with champion-specific analytics
- Access build recommendations and itemization strategies
- Share profile cards with performance summaries

The frontend leverages modern web technologies including TanStack Router for navigation, Tailwind CSS for responsive styling, and shadcn/ui components for consistent UI patterns. Real-time WebSocket connections keep users informed about scan progress and data processing status.

### Backend API Services
The Hono-based API server handles all data processing and business logic:
- **Regional Queue Management**: BullMQ queues organized by geographic clusters (Americas, Europe, Asia, SEA, Esports) ensure efficient match data processing
- **Riot API Integration**: Custom rate-limited client with exponential backoff handles all Riot API communications
- **Real-time Processing**: WebSocket support for live scan progress updates and instant insight delivery
- **Data Aggregation**: Sophisticated MongoDB aggregations for player statistics, champion performance, and matchup analysis

### Data Processing Pipeline

#### Match Ingestion System
The platform processes match data through a multi-stage pipeline:
1. **Match Listing**: Discovers all available matches for a player account
2. **Match Fetching**: Retrieves detailed match information from Riot APIs
3. **Timeline Processing**: Analyzes game timeline data for granular insights
4. **Data Enrichment**: Augments raw data with champion, item, and role context

#### AI-Powered Analysis
AWS Bedrock integration provides intelligent coaching features:
- **Match Insights**: AI-generated summaries of key moments and decision points
- **Playstyle Analysis**: Identification of player strengths and improvement areas
- **Build Recommendations**: Context-aware itemization suggestions based on meta and performance
- **Badge Generation**: AI-curated performance badges that highlight unique playstyles

### Data Storage & Management

#### MongoDB Database
- Stores raw match data and processed timelines
- Enables complex aggregations for statistical analysis
- Maintains player profiles and historical performance data
- Supports real-time querying for instant insights

#### Redis Caching
- Manages rate limiting and API quota enforcement
- Provides real-time scan progress tracking
- Caches frequently accessed data for performance
- Coordinates distributed queue processing

#### Data Dragon Integration
- Static game data for champions, items, and runes
- Localized content support for multiple regions
- Metadata enrichment for AI prompt context

## Key Features

### Year-in-Review Analytics
Comprehensive annual performance summaries that include:
- Champion mastery progression and role specialization
- Win rate trends and performance metrics over time
- Comparison against peer cohort statistics
- Seasonal performance breakdowns

### Real-time Match Analysis
Instant insights for individual matches featuring:
- Lane opponent comparison and matchup analysis
- Key moment identification and decision evaluation
- Build path optimization suggestions
- Macro play recommendations

### Professional Player Integration
Special features for esports competitors:
- Pro player identification and verification
- Team-specific analytics and performance tracking
- Tournament preparation tools and scouting insights

### Advanced Statistical Modeling
Sophisticated data processing capabilities:
- Cohort percentiles and normalized performance metrics
- Champion-role specific statistical benchmarks
- Item build frequency and win rate analysis
- Synergy and counter-pick analytics

## Technical Implementation

The platform employs a microservices architecture with clear separation of concerns:

### Regional Processing Strategy
Matches are processed through region-specific queues that:
- Respect Riot API rate limits per geographic cluster
- Provide fault isolation between different regions
- Enable parallel processing for global scalability
- Maintain optimal performance during peak usage

### AI Integration Approach
The AI coaching system uses:
- Structured prompt engineering for consistent output
- Context injection from game metadata for accuracy
- Caching layers to optimize model usage costs
- Multiple specialized agents for different analysis types

### Data Aggregation Framework
Advanced MongoDB aggregation pipelines that:
- Process millions of match records efficiently
- Generate real-time statistical insights
- Support complex cohort comparisons
- Enable personalized player analytics

## Development Philosophy

RiftCoach emphasizes:
- **Performance**: Optimized data processing and minimal latency
- **Accuracy**: Statistically sound analysis and reliable insights
- **Usability**: Intuitive interfaces and actionable recommendations
- **Scalability**: Architecture designed for global player base support
- **Innovation**: Continuous improvement of AI and analytics capabilities

