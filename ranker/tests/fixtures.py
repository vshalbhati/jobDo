"""Realistic postings and a resume, shared by the tests."""

RESUME = """Vishal Kumar
Bengaluru, India | vishal@example.com | github.com/vk

SUMMARY
Full stack software engineer with 4 years of experience building web applications with React,
TypeScript and Node.js, deployed on AWS.

EXPERIENCE
Software Engineer, Acme Payments — Jan 2022 - Present
- Built React and TypeScript dashboards used by 40k merchants; Redux for state.
- Designed REST APIs in Node.js and Express backed by PostgreSQL and Redis.
- Containerised services with Docker and ran them on AWS ECS; CI/CD with GitHub Actions.
- Wrote unit tests with Jest and end-to-end tests with Cypress.

Associate Software Engineer, Brightlabs — Jul 2020 - Dec 2021
- Built features in Angular and Java Spring Boot; MySQL.
- Agile/Scrum, code reviews, Jira.

SKILLS
JavaScript, TypeScript, React, Redux, Node.js, Express, PostgreSQL, MySQL, Redis, Docker, AWS,
GitHub Actions, Jest, Cypress, HTML, CSS, Tailwind, Git, REST APIs, Microservices

EDUCATION
B.Tech in Computer Science, VIT University, 2020
"""

PROFILE = {
    "defaultYears": 4,
    "currentTitle": "Software Engineer",
    "titles": ["Software Engineer", "Associate Software Engineer", "Full Stack Developer"],
    "education": "Bachelor's Degree",
    "country": "India",
    "skills": {"javascript": 4, "typescript": 3, "react": 4, "node.js": 3, "express": 3,
               "postgresql": 3, "docker": 2, "aws": 2, "jest": 3},
}

STRONG = {"id": "strong", "title": "Senior Frontend Engineer (React)", "description": """
About Us
Payly builds payment tools for small businesses across India.

What you'll do
- Build and ship features in our React and TypeScript web app.
- Work with backend engineers on Node.js REST APIs.
- Improve performance and accessibility of our dashboard.

Requirements
- 3-6 years of experience building web applications.
- Strong proficiency in React, TypeScript and modern JavaScript.
- Experience with Redux or similar state management.
- Experience writing tests with Jest or Cypress.
- Comfortable with Git and CI/CD pipelines.

Nice to have
- Experience with Next.js.
- Exposure to AWS.

Benefits
Health insurance, flexible hours, learning budget.
"""}

STRETCH = {"id": "stretch", "title": "Staff Backend Engineer", "description": """
The Role
You will lead the design of our distributed platform and mentor engineers across teams.

Requirements
- 10+ years of professional software development experience.
- Deep expertise in Go or Java and distributed systems.
- Experience with Kafka, Kubernetes and Cassandra at scale.
- Track record of technical leadership.

Preferred Qualifications
- Experience with gRPC and Terraform.
"""}

WRONG_FIELD = {"id": "wrong", "title": "Data Scientist", "description": """
Responsibilities
- Build machine learning models for credit risk and fraud detection.
- Run A/B tests and statistical analysis to evaluate models.

Qualifications
- 3+ years of experience in data science.
- Strong Python, pandas, scikit-learn and SQL.
- Experience with PyTorch or TensorFlow.
- Master's degree in Statistics, Computer Science or a related field.
"""}

CLEARANCE = {"id": "clearance", "title": "Software Engineer", "description": """
Requirements
- 3+ years of experience with React and Node.js.
- Active TS/SCI security clearance required.
- US citizenship is required.
"""}

LANGUAGE = {"id": "language", "title": "Frontend Developer", "description": """
Your profile
- 3+ years of experience with React and TypeScript.
- Fluent German (C1) is required for daily work with our Berlin team.
"""}

NAUKRI_INLINE = {"id": "naukri", "title": "Full Stack Developer - Node.js / React", "description": (
    "Job description We are hiring a full stack developer for our fintech product team in Bengaluru. "
    "Responsibilities: Develop REST APIs using Node.js and Express. Build responsive UIs with React. "
    "Write clean, testable code. Requirements: 2-5 Yrs of experience in full stack development. "
    "Hands-on experience with MongoDB or PostgreSQL. Good to have: Docker, AWS. "
    "Role: Full Stack Developer Industry Type: FinTech Department: Engineering "
    "Education UG: B.Tech/B.E. in Any Specialization Key Skills: Node.js React Express MongoDB REST"
)}

THIN = {"id": "thin", "title": "Software Engineer", "description": "Join our team. Apply now."}

EMPTY = {"id": "empty", "title": "React Developer", "description": ""}

ALL = [STRONG, STRETCH, WRONG_FIELD, CLEARANCE, LANGUAGE, NAUKRI_INLINE, THIN, EMPTY]
