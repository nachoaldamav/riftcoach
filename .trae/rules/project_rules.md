This project is an app submission for a hackathon, the project is called "Riftcoach".

The hackathon consists of creating a year review for players of League of Legends using it's match history. My app aims to provide a detailed analysis of a player's performance in a given year, highlighting their strengths, weaknesses, and overall progress. One of the rules is that the project _needs_ to use AWS tools, specifically AI tools, like Bedrock or Sagemaker.

This project aims to have 2 main features:

1. A year review feature that allows users to input a player's name and a year, and receive a detailed analysis of their performance in that year.
2. A specific match review feature that allows users to go to a specific match and receive a detailed analysis of that match, highlighting the player's performance in that match (Using their match history data to provide a detailed analysis of the player's performance in that match compared to the whole year).

## Technical Details

- Hono for the backend API
- React + Tanstack Start + TailwindCSS (shadcn/ui) for the frontend
- AWS Bedrock or Sagemaker for the AI tools
- Athena + S3 for the match history data storage and querying
