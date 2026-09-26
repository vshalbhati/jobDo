"""Skill taxonomy: canonical names, the ways people write them, and families.

A family groups skills that substitute for each other in practice (React and
Vue, PostgreSQL and MySQL). A posting that asks for Vue is not a miss for
someone who knows React, but it is not a full match either, so family members
earn partial credit.

Aliases are matched case-insensitively with word boundaries. An alias
starting with "=" is matched case-sensitively, for words that are also plain
English ("Swift", "Excel", "REST"). A handful of skills that collide badly
with English ("Go", "R", "C") get hand-written patterns instead.
"""
import re

# (canonical, family, aliases)
_TAXONOMY = [
    # ---------------------------------------------------------------- languages
    ("javascript", "js-lang", ["javascript", "js", "es6", "ecmascript", "vanilla js"]),
    ("typescript", "js-lang", ["typescript"]),
    ("python", "python", ["python", "python3", "python 3"]),
    ("java", "jvm-lang", ["java", "java 8", "java 11", "java 17", "core java", "j2ee", "java ee", "jee"]),
    ("kotlin", "jvm-lang", ["kotlin"]),
    ("scala", "jvm-lang", ["scala"]),
    ("c#", "dotnet", ["c#", "csharp", "c sharp"]),
    (".net", "dotnet", [".net", "dotnet", ".net core", "dotnet core", ".net framework"]),
    ("asp.net", "dotnet", ["asp.net", "asp.net core", "asp.net mvc"]),
    ("c++", "systems-lang", ["c++", "cpp", "c plus plus"]),
    ("rust", "systems-lang", ["=Rust"]),
    ("php", "php", ["php"]),
    ("ruby", "ruby", ["ruby"]),
    ("swift", "apple", ["=Swift", "swift ui", "swiftui"]),
    ("objective-c", "apple", ["objective-c", "objective c", "objc"]),
    ("dart", "cross-mobile", ["=Dart"]),
    ("perl", "scripting", ["perl"]),
    ("bash", "scripting", ["bash", "shell scripting", "shell script", "shell scripts", "unix shell"]),
    ("powershell", "scripting", ["powershell"]),
    ("elixir", "functional", ["elixir"]),
    ("haskell", "functional", ["haskell"]),
    ("clojure", "functional", ["clojure"]),
    ("matlab", "numeric", ["matlab"]),
    ("sql", "sql", ["sql", "t-sql", "tsql", "pl/sql", "plsql", "sql queries"]),
    ("vba", "scripting", ["vba", "excel macros"]),
    ("cobol", "mainframe", ["cobol"]),
    ("abap", "erp", ["abap"]),
    ("solidity", "web3", ["solidity"]),

    # ------------------------------------------------------------ web frontend
    ("react", "frontend-framework", ["react", "react.js", "reactjs", "react js"]),
    ("angular", "frontend-framework", ["angular", "angularjs", "angular.js", "angular 2+"]),
    ("vue", "frontend-framework", ["vue", "vue.js", "vuejs", "vue 3"]),
    ("svelte", "frontend-framework", ["svelte", "sveltekit"]),
    ("next.js", "frontend-meta", ["next.js", "nextjs", "next js"]),
    ("nuxt", "frontend-meta", ["nuxt", "nuxt.js", "nuxtjs"]),
    ("redux", "frontend-state", ["redux", "redux toolkit", "mobx", "zustand", "ngrx"]),
    ("jquery", "frontend-legacy", ["jquery"]),
    ("html", "markup", ["html", "html5"]),
    ("css", "styling", ["css", "css3"]),
    ("sass", "styling", ["sass", "scss"]),
    ("tailwind", "styling", ["tailwind", "tailwindcss", "tailwind css"]),
    ("bootstrap", "styling", ["bootstrap"]),
    ("material ui", "styling", ["material ui", "material-ui", "mui", "chakra ui", "ant design"]),
    ("webpack", "bundler", ["webpack", "vite", "rollup", "esbuild", "babel", "parcel"]),
    ("web accessibility", "frontend-quality", ["accessibility", "a11y", "wcag"]),
    ("responsive design", "frontend-quality", ["responsive design", "responsive web design", "mobile-first"]),
    ("web performance", "frontend-quality", ["web performance", "core web vitals", "lighthouse"]),

    # --------------------------------------------------------------- backend
    ("node.js", "js-backend", ["node.js", "nodejs", "node js", "=Node"]),
    ("express", "js-backend", ["express.js", "expressjs", "=Express"]),
    ("nestjs", "js-backend", ["nestjs", "nest.js"]),
    ("django", "python-web", ["django", "django rest framework", "drf"]),
    ("flask", "python-web", ["flask"]),
    ("fastapi", "python-web", ["fastapi"]),
    ("spring boot", "jvm-web", ["spring boot", "springboot"]),
    ("spring", "jvm-web", ["=Spring", "spring framework", "spring mvc", "spring cloud", "spring security"]),
    ("hibernate", "orm", ["hibernate", "jpa", "entity framework", "sqlalchemy", "sequelize", "typeorm", "prisma"]),
    ("rails", "ruby", ["rails", "ruby on rails", "ror"]),
    ("laravel", "php", ["laravel", "symfony", "codeigniter"]),
    ("graphql", "api-style", ["graphql", "apollo"]),
    ("rest api", "api-style", ["=REST", "restful", "rest api", "rest apis", "restful api", "restful apis", "rest services", "restful services", "rest-based"]),
    ("grpc", "api-style", ["grpc", "protobuf", "protocol buffers"]),
    ("websockets", "realtime", ["websocket", "websockets", "socket.io"]),
    ("microservices", "architecture", ["microservices", "micro-services", "microservice architecture", "service-oriented architecture", "soa"]),
    ("distributed systems", "architecture", ["distributed systems", "distributed computing", "scalable systems", "high availability", "high-availability"]),
    ("system design", "architecture", ["system design", "software architecture", "design patterns", "solid principles"]),
    ("event-driven architecture", "architecture", ["event-driven", "event driven", "event sourcing", "cqrs"]),

    # ----------------------------------------------------------- messaging
    ("kafka", "messaging", ["kafka", "apache kafka", "kafka streams"]),
    ("rabbitmq", "messaging", ["rabbitmq", "activemq", "amqp"]),
    ("sqs", "messaging", ["sqs", "sns", "amazon sqs", "google pub/sub", "pub/sub", "pubsub", "azure service bus"]),
    ("celery", "task-queue", ["celery", "sidekiq", "bullmq"]),

    # ----------------------------------------------------------- databases
    ("postgresql", "relational-db", ["postgresql", "postgres", "psql"]),
    ("mysql", "relational-db", ["mysql", "mariadb"]),
    ("sql server", "relational-db", ["sql server", "mssql", "ms sql", "microsoft sql server"]),
    ("oracle database", "relational-db", ["oracle db", "oracle database", "oracle 19c", "=Oracle"]),
    ("sqlite", "relational-db", ["sqlite"]),
    ("mongodb", "document-db", ["mongodb", "mongo", "mongoose"]),
    ("dynamodb", "document-db", ["dynamodb", "cosmos db", "cosmosdb", "firestore", "couchbase", "couchdb"]),
    ("cassandra", "wide-column-db", ["cassandra", "scylladb", "hbase", "bigtable"]),
    ("redis", "cache", ["redis", "memcached", "elasticache"]),
    ("elasticsearch", "search", ["elasticsearch", "elastic search", "opensearch", "solr", "lucene"]),
    ("neo4j", "graph-db", ["neo4j", "graph database", "graph databases"]),
    ("database design", "data-modeling", ["database design", "data modeling", "data modelling", "schema design", "normalization"]),

    # ------------------------------------------------------------ data eng
    ("spark", "big-data", ["spark", "apache spark", "pyspark", "spark sql"]),
    ("hadoop", "big-data", ["hadoop", "hdfs", "mapreduce", "hive", "pig"]),
    ("flink", "streaming", ["flink", "apache flink", "spark streaming", "kinesis", "apache beam", "dataflow"]),
    ("databricks", "lakehouse", ["databricks", "delta lake"]),
    ("snowflake", "warehouse", ["snowflake"]),
    ("redshift", "warehouse", ["redshift", "amazon redshift"]),
    ("bigquery", "warehouse", ["bigquery", "big query"]),
    ("airflow", "orchestration", ["airflow", "apache airflow", "dagster", "prefect", "luigi", "azure data factory", "adf"]),
    ("dbt", "transformation", ["dbt", "data build tool"]),
    ("etl", "data-pipelines", ["etl", "elt", "data pipelines", "data pipeline", "data ingestion", "informatica", "talend", "ssis"]),
    ("data warehousing", "warehouse", ["data warehouse", "data warehousing", "data lake", "data lakes", "dimensional modeling", "star schema"]),

    # --------------------------------------------------------- analytics / BI
    ("tableau", "bi", ["tableau"]),
    ("power bi", "bi", ["power bi", "powerbi", "dax", "power query"]),
    ("looker", "bi", ["looker", "looker studio", "google data studio", "metabase", "superset", "qlik", "qlikview", "qlik sense"]),
    ("excel", "spreadsheets", ["=Excel", "ms excel", "microsoft excel", "advanced excel", "pivot tables", "vlookup", "google sheets"]),
    ("statistics", "stats", ["statistics", "statistical analysis", "statistical modeling", "hypothesis testing", "regression analysis"]),
    ("a/b testing", "experimentation", ["a/b testing", "a/b tests", "ab testing", "experimentation", "split testing"]),
    ("data analysis", "analysis", ["data analysis", "data analytics", "exploratory data analysis", "eda", "data visualization", "data visualisation"]),
    ("pandas", "py-data", ["pandas", "numpy", "scipy", "polars"]),
    ("jupyter", "py-data", ["jupyter", "jupyter notebooks"]),
    ("r", "stats-lang", []),  # hand-written pattern below
    ("sas", "stats-lang", ["=SAS", "spss", "stata"]),

    # ------------------------------------------------------------------ ML/AI
    ("machine learning", "ml", ["machine learning", "ml", "predictive modeling", "predictive modelling"]),
    ("deep learning", "ml", ["deep learning", "neural networks", "neural network", "cnn", "rnn", "transformers"]),
    ("nlp", "ml-domain", ["nlp", "natural language processing", "text mining", "named entity recognition"]),
    ("computer vision", "ml-domain", ["computer vision", "image processing", "opencv", "object detection", "image recognition"]),
    ("recommender systems", "ml-domain", ["recommender systems", "recommendation systems", "recommendation engine", "personalization"]),
    ("time series", "ml-domain", ["time series", "time-series", "forecasting models"]),
    ("pytorch", "ml-framework", ["pytorch", "torch"]),
    ("tensorflow", "ml-framework", ["tensorflow", "keras", "tf2"]),
    ("scikit-learn", "ml-framework", ["scikit-learn", "sklearn", "scikit learn", "xgboost", "lightgbm", "catboost"]),
    ("hugging face", "ml-framework", ["hugging face", "huggingface"]),
    ("llm", "genai", ["llm", "llms", "large language model", "large language models", "gpt", "openai", "claude", "gemini", "llama"]),
    ("generative ai", "genai", ["generative ai", "genai", "gen ai", "gen-ai"]),
    ("langchain", "genai", ["langchain", "llamaindex", "llama index", "semantic kernel", "langgraph"]),
    ("rag", "genai", ["rag", "retrieval augmented generation", "retrieval-augmented generation", "vector database", "vector databases", "pinecone", "weaviate", "chromadb", "faiss", "pgvector"]),
    ("prompt engineering", "genai", ["prompt engineering", "prompt design"]),
    ("mlops", "mlops", ["mlops", "ml ops", "mlflow", "kubeflow", "sagemaker", "vertex ai", "model deployment", "model serving"]),

    # ---------------------------------------------------------------- cloud
    ("aws", "cloud", ["aws", "amazon web services", "ec2", "s3", "aws lambda", "cloudwatch", "ecs", "fargate", "rds", "iam roles"]),
    ("azure", "cloud", ["azure", "microsoft azure", "azure functions", "azure devops"]),
    ("gcp", "cloud", ["gcp", "google cloud", "google cloud platform", "cloud run", "cloud functions", "app engine"]),
    ("serverless", "cloud-pattern", ["serverless", "faas"]),
    ("firebase", "baas", ["firebase", "supabase", "appwrite"]),
    ("vercel", "hosting", ["vercel", "netlify", "heroku", "render.com"]),

    # --------------------------------------------------------------- devops
    ("docker", "containers", ["docker", "containerization", "containerisation", "podman", "docker compose"]),
    ("kubernetes", "orchestrators", ["kubernetes", "k8s", "eks", "aks", "gke", "openshift", "helm", "kustomize"]),
    ("terraform", "iac", ["terraform", "cloudformation", "pulumi", "bicep", "arm templates", "infrastructure as code", "iac", "cdk"]),
    ("ansible", "config-mgmt", ["ansible", "chef", "puppet", "saltstack"]),
    ("ci/cd", "ci", ["ci/cd", "cicd", "ci cd", "continuous integration", "continuous delivery", "continuous deployment", "build pipelines", "deployment pipelines"]),
    ("jenkins", "ci", ["jenkins", "github actions", "gitlab ci", "gitlab-ci", "circleci", "travis ci", "bamboo", "teamcity", "argocd", "argo cd", "tekton", "spinnaker"]),
    ("git", "vcs", ["git", "github", "gitlab", "bitbucket", "version control"]),
    ("linux", "os", ["linux", "unix", "ubuntu", "centos", "rhel", "red hat"]),
    ("nginx", "web-server", ["nginx", "apache httpd", "haproxy", "envoy", "load balancing", "load balancers"]),
    ("observability", "monitoring", ["observability", "datadog", "splunk", "grafana", "prometheus", "new relic", "elk", "elk stack", "kibana", "logstash", "opentelemetry", "dynatrace", "appdynamics", "sentry"]),
    ("computer networking", "networking", ["network engineering", "networking protocols", "tcp/ip", "dns", "vpn", "vpc", "firewalls", "subnetting", "routing and switching", "ccna"]),
    ("sre", "reliability", ["sre", "site reliability", "incident management", "on-call", "slos", "slis", "chaos engineering"]),

    # ------------------------------------------------------------- security
    ("application security", "security", ["application security", "appsec", "owasp", "secure coding", "sast", "dast", "threat modeling"]),
    ("penetration testing", "security", ["penetration testing", "pen testing", "pentesting", "ethical hacking", "burp suite", "metasploit", "vulnerability assessment"]),
    ("cloud security", "security", ["cloud security", "cspm", "zero trust"]),
    ("siem", "security-ops", ["siem", "soc analyst", "security operations center", "security operations", "qradar", "sentinel", "incident response", "threat hunting", "edr"]),
    ("identity management", "identity", ["iam", "identity and access management", "oauth", "oauth2", "openid connect", "oidc", "saml", "sso", "single sign-on", "okta", "keycloak", "active directory", "ldap"]),
    ("cryptography", "security", ["cryptography", "encryption", "pki", "tls", "ssl"]),
    ("regulatory compliance", "grc", ["regulatory compliance", "gdpr", "hipaa", "soc 2", "soc2", "pci dss", "pci-dss", "iso 27001", "nist", "sox", "risk assessment"]),

    # -------------------------------------------------------------- testing
    ("selenium", "ui-automation", ["selenium", "webdriver", "selenium webdriver", "webdriverio"]),
    ("cypress", "ui-automation", ["cypress"]),
    ("playwright", "ui-automation", ["playwright", "puppeteer"]),
    ("appium", "mobile-automation", ["appium", "espresso", "xcuitest", "detox"]),
    ("jest", "unit-testing", ["jest", "mocha", "chai", "jasmine", "vitest", "karma", "react testing library", "enzyme"]),
    ("junit", "unit-testing", ["junit", "testng", "mockito", "nunit", "xunit"]),
    ("pytest", "unit-testing", ["pytest", "unittest"]),
    ("test automation", "qa", ["test automation", "automation testing", "automated testing", "automation framework", "test frameworks", "sdet"]),
    ("manual testing", "qa", ["manual testing", "functional testing", "regression testing", "test cases", "test plans", "uat", "user acceptance testing", "smoke testing"]),
    ("api testing", "qa", ["api testing", "postman", "rest assured", "rest-assured", "soapui", "karate"]),
    ("performance testing", "qa", ["performance testing", "load testing", "stress testing", "jmeter", "gatling", "locust", "k6"]),
    ("bdd", "qa", ["bdd", "cucumber", "gherkin", "specflow", "behave"]),
    ("tdd", "engineering-practice", ["tdd", "test-driven development", "test driven development", "unit testing"]),

    # --------------------------------------------------------------- mobile
    ("android", "native-mobile", ["android", "android sdk", "android studio", "jetpack", "jetpack compose"]),
    ("ios", "native-mobile", ["ios", "xcode", "uikit", "cocoapods"]),
    ("react native", "cross-mobile", ["react native", "react-native", "expo"]),
    ("flutter", "cross-mobile", ["flutter"]),
    ("xamarin", "cross-mobile", ["xamarin", ".net maui", "maui", "ionic", "cordova", "capacitor"]),

    # ------------------------------------------------------------- practices
    ("agile", "process", ["agile", "scrum", "kanban", "sprint planning", "safe agile"]),
    ("jira", "pm-tools", ["jira", "confluence", "asana", "trello", "monday.com", "clickup"]),
    ("code review", "engineering-practice", ["code review", "code reviews", "pull requests", "peer review"]),
    ("mentoring", "leadership", ["mentoring", "mentorship", "coaching engineers", "technical leadership", "tech lead", "team leadership", "people management"]),

    # --------------------------------------------------------- product/design
    ("product management", "product", ["product management", "product strategy", "product roadmap", "roadmapping", "product discovery", "go-to-market", "gtm", "product lifecycle"]),
    ("project management", "project", ["project management", "program management", "pmp", "prince2", "project planning", "delivery management"]),
    ("stakeholder management", "business-soft", ["stakeholder management", "stakeholder communication", "cross-functional collaboration", "cross-functional teams"]),
    ("business analysis", "business-analysis", ["business analysis", "requirements gathering", "requirement gathering", "brd", "frd", "user stories", "process mapping", "gap analysis", "use cases"]),
    ("user research", "ux", ["user research", "usability testing", "user interviews", "customer research", "personas", "journey mapping"]),
    ("ux design", "ux", ["ux", "ux design", "user experience", "interaction design", "information architecture"]),
    ("ui design", "ui", ["ui design", "ui/ux", "visual design", "user interface design", "design systems", "design system"]),
    ("figma", "design-tools", ["figma", "sketch", "adobe xd", "invision", "framer", "zeplin"]),
    ("adobe creative suite", "design-tools", ["photoshop", "illustrator", "indesign", "after effects", "premiere pro", "adobe creative suite", "adobe creative cloud", "canva"]),
    ("wireframing", "ux", ["wireframing", "wireframes", "prototyping", "prototypes", "mockups"]),

    # ------------------------------------------------------- business / ops
    ("salesforce", "crm", ["salesforce", "sfdc", "salesforce crm", "apex", "lightning web components"]),
    ("crm", "crm", ["hubspot", "zoho crm", "pipedrive", "dynamics 365"]),
    ("sap", "erp", ["=SAP", "sap erp", "sap s/4hana", "s/4hana", "sap fico", "sap mm", "sap sd", "oracle erp", "netsuite", "odoo"]),
    ("servicenow", "itsm", ["servicenow", "itil", "itsm", "remedy"]),
    ("workday", "hris", ["workday", "successfactors", "bamboohr", "hris", "hrms"]),
    ("digital marketing", "marketing", ["digital marketing", "performance marketing", "growth marketing", "online marketing"]),
    ("seo", "marketing", ["seo", "search engine optimization", "search engine optimisation"]),
    ("sem", "paid-ads", ["sem", "ppc", "google ads", "adwords", "paid search", "meta ads", "facebook ads", "paid social"]),
    ("social media marketing", "marketing", ["social media marketing", "social media management", "smm", "community management"]),
    ("content marketing", "content", ["content marketing", "content strategy", "copywriting", "content writing", "technical writing"]),
    ("email marketing", "marketing", ["email marketing", "marketing automation", "mailchimp", "marketo", "braze", "klaviyo"]),
    ("google analytics", "web-analytics", ["google analytics", "ga4", "mixpanel", "amplitude", "adobe analytics", "segment"]),
    ("b2b sales", "sales", ["b2b sales", "enterprise sales", "saas sales", "inside sales", "outbound sales", "business development", "lead generation", "prospecting", "cold calling", "pipeline management"]),
    ("account management", "customer", ["account management", "key account management", "client relationship management", "client servicing", "customer success", "customer retention", "upselling", "cross-selling"]),
    ("customer support", "customer", ["customer support", "customer service", "technical support", "helpdesk", "help desk", "zendesk", "freshdesk", "ticketing"]),
    ("negotiation", "sales", ["negotiation", "contract negotiation", "vendor negotiation", "deal closing"]),
    ("financial modeling", "finance", ["financial modeling", "financial modelling", "financial analysis", "valuation", "dcf", "fp&a", "financial planning"]),
    ("accounting", "accounting", ["accounting", "bookkeeping", "general ledger", "accounts payable", "accounts receivable", "reconciliation", "month-end close", "ifrs", "us gaap", "gaap", "ind as"]),
    ("taxation", "accounting", ["taxation", "tax compliance", "gst", "tds", "income tax", "direct tax", "indirect tax", "transfer pricing"]),
    ("tally", "accounting-tools", ["tally", "tally erp", "quickbooks", "xero", "zoho books"]),
    ("auditing", "audit", ["internal audit", "statutory audit", "external audit", "internal controls"]),
    ("budgeting", "finance", ["budgeting", "forecasting", "variance analysis", "cost analysis", "cost control"]),
    ("recruiting", "talent", ["recruiting", "recruitment", "talent acquisition", "sourcing", "headhunting", "technical recruiting", "boolean search", "applicant tracking system"]),
    ("payroll", "hr-ops", ["payroll", "payroll processing", "compensation and benefits", "c&b"]),
    ("employee relations", "hr", ["employee relations", "employee engagement", "performance management", "hr policies", "hr operations"]),
    ("supply chain", "supply-chain", ["supply chain", "supply chain management", "scm", "demand planning", "inventory management", "warehouse management", "logistics", "procurement", "sourcing strategy", "vendor management"]),
    ("six sigma", "process-excellence", ["six sigma", "lean six sigma", "kaizen", "process improvement", "continuous improvement", "root cause analysis"]),
    ("risk management", "risk", ["risk management", "credit risk", "market risk", "operational risk", "risk analysis"]),
    ("kyc", "fin-crime", ["kyc", "know your customer", "aml", "anti-money laundering", "anti money laundering", "cdd", "edd", "sanctions screening", "transaction monitoring", "fraud detection", "fraud prevention"]),
    ("payments", "fintech", ["payments", "payment gateway", "payment processing", "upi", "card payments", "stripe", "razorpay", "adyen"]),
    ("blockchain", "web3", ["blockchain", "web3", "ethereum", "smart contracts", "defi"]),
    ("embedded systems", "embedded", ["embedded systems", "embedded c", "firmware", "rtos", "microcontrollers", "arm cortex", "iot"]),
    ("game development", "games", ["unity", "unreal engine", "game development", "gamedev"]),
    ("wordpress", "cms", ["wordpress", "drupal", "joomla", "contentful", "strapi", "sanity"]),
    ("shopify", "ecommerce", ["shopify", "magento", "woocommerce", "bigcommerce"]),
    ("api development", "api-style", ["api development", "api design", "api integration", "api integrations", "web services"]),
    ("oop", "cs-fundamentals", ["oop", "object-oriented programming", "object oriented programming", "object-oriented design", "ood"]),
    ("data structures and algorithms", "cs-fundamentals", ["data structures", "algorithms", "dsa"]),
    ("concurrency", "cs-fundamentals", ["multithreading", "multi-threading", "concurrent programming"]),
    ("performance optimization", "engineering-practice", ["performance tuning", "query optimization", "profiling"]),
]

# Hand-written patterns for skill names that are ordinary English words.
_SPECIAL = {
    # "Go" only when capitalised and not in "go to", "go live", "go-to-market"...
    "go": (
        "golang-family",
        re.compile(
            r"(?i:\bgolang\b)|(?<![\w.#+-])Go(?![\w+#-])(?!\s+(?:to|live|ahead|back|through|beyond|above|with|for|the|a|an|on|out|further|deeper)\b)"
        ),
    ),
    # The language R: a lone capital R, never "R&D", "R&R", an initial or a possessive.
    "r": (
        "stats-lang",
        re.compile(r"(?<![\w.&/'’-])R(?![\w+#&'’-])(?!\.\w)(?!\s*&)"),
    ),
    # The language C: a lone capital C, not "C-level", "C++", "C#", "Series C", "Grade C".
    "c": (
        "systems-lang",
        re.compile(r"(?<![\w+#.-])(?<!Series )(?<!series )(?<!Grade )(?<!Level )C(?![\w+#-])(?!\.\w)(?!\s*/\s*C\+\+)|\bC/C\+\+"),
    ),
}

# Families that are close enough to earn a little extra credit for each other.
_ADJACENT_FAMILIES = {
    ("frontend-framework", "frontend-meta"),
    ("js-lang", "js-backend"),
    ("jvm-lang", "jvm-web"),
    ("python", "python-web"),
    ("python", "py-data"),
    ("relational-db", "sql"),
    ("warehouse", "lakehouse"),
    ("big-data", "streaming"),
    ("messaging", "streaming"),
    ("containers", "orchestrators"),
    ("ci", "iac"),
    ("iac", "config-mgmt"),
    ("ml", "ml-framework"),
    ("ml", "ml-domain"),
    ("genai", "ml"),
    ("ui-automation", "qa"),
    ("unit-testing", "engineering-practice"),
    ("native-mobile", "cross-mobile"),
    ("ux", "ui"),
    ("ui", "design-tools"),
    ("crm", "sales"),
    ("marketing", "paid-ads"),
    ("accounting", "accounting-tools"),
}


def _alias_pattern(alias):
    """A regex for one alias, with boundaries that respect c++, .net, node.js."""
    case_sensitive = alias.startswith("=")
    text = alias[1:] if case_sensitive else alias
    esc = re.escape(text).replace(r"\ ", r"[\s-]+")
    left = r"(?<![a-zA-Z0-9+#.])" if text[0].isalnum() else r"(?<![a-zA-Z0-9])"
    right = r"(?![a-zA-Z0-9+#])" if text[-1].isalnum() else r"(?![a-zA-Z0-9])"
    body = left + esc + right
    return body if case_sensitive else "(?i:" + body + ")"


class Skill:
    __slots__ = ("name", "family", "pattern", "needles")

    def __init__(self, name, family, pattern, needles=None):
        self.name = name
        self.family = family
        self.pattern = pattern
        # Lower-cased fragments one of which must be in the text for the
        # pattern to match. A posting names a handful of the ~220 skills, and
        # a substring test is far cheaper than the regex it saves.
        self.needles = needles


def _needle(alias):
    """A part of an alias that appears as written in any text it matches.

    Only the spaces in an alias are flexible (see _alias_pattern), so each word
    is literal; the longest is the rarest, so it rules out the most text.
    """
    return max(alias.lstrip("=").lower().split(" "), key=len)


def _build():
    skills = {}
    for name, family, aliases in _TAXONOMY:
        if name in _SPECIAL:
            continue
        # A case-sensitive alias of the name itself ("=Excel") replaces the
        # name, so "you excel at" does not match through the back door.
        cs_self = any(a.startswith("=") and a[1:].lower() == name for a in aliases)
        variants = ([] if cs_self else [name]) + [a for a in aliases if a.lower() != name]
        # Longest first, so "spring boot" wins over "spring" inside one skill.
        variants.sort(key=lambda a: -len(a.lstrip("=")))
        pattern = re.compile("|".join(_alias_pattern(a) for a in variants))
        skills[name] = Skill(name, family, pattern, tuple({_needle(a) for a in variants}))
    for name, (family, pattern) in _SPECIAL.items():
        skills[name] = Skill(name, family, pattern)
    return skills


SKILLS = _build()

# Every alias, lower-cased, pointing at its canonical skill. Used to map the
# free-form skill names in a profile ("ReactJS", "k8s") onto the taxonomy.
ALIAS_INDEX = {}
for _name, _family, _aliases in _TAXONOMY:
    ALIAS_INDEX[_name] = _name
    for _a in _aliases:
        ALIAS_INDEX.setdefault(_a.lstrip("=").lower(), _name)
ALIAS_INDEX.update({"go": "go", "golang": "go", "r": "r", "c": "c"})


def canonical(name):
    """Maps a user-written skill name onto the taxonomy, or returns it cleaned."""
    key = re.sub(r"\s+", " ", str(name or "").strip().lower())
    return ALIAS_INDEX.get(key, key)


def family_of(name):
    s = SKILLS.get(name)
    return s.family if s else None


def related(a, b):
    """0..1: how much knowing skill a counts toward a posting asking for b."""
    if a == b:
        return 1.0
    fa, fb = family_of(a), family_of(b)
    if not fa or not fb:
        return 0.0
    if fa == fb:
        return 0.5
    if (fa, fb) in _ADJACENT_FAMILIES or (fb, fa) in _ADJACENT_FAMILIES:
        return 0.3
    return 0.0


def present(names, text):
    """Which of these custom skill names appear in text at all (cheap)."""
    return sorted(n for n in names if len(n) >= 2 and n not in SKILLS
                  and re.search(_alias_pattern(n), text or ""))


def find_skills(text, extra=None, spans=None):
    """Every skill in text as {name: [match start offsets]}.

    extra: additional custom skill names (from the candidate's profile) that
    are not in the taxonomy, matched literally.
    spans: a list to append each match's (start, end) to, for callers that
    need to know which stretches of text were recognised.
    """
    found = {}
    if not text:
        return found
    low = text.lower()
    for skill in SKILLS.values():
        if skill.needles and not any(n in low for n in skill.needles):
            continue
        matches = list(skill.pattern.finditer(text))
        if matches:
            found[skill.name] = [m.start() for m in matches]
            if spans is not None:
                spans.extend((m.start(), m.end()) for m in matches)
    for name in extra or ():
        if name in found or name in SKILLS or len(name) < 2:
            continue
        pat = re.compile(_alias_pattern(name))
        matches = list(pat.finditer(text))
        if matches:
            found[name] = [m.start() for m in matches]
            if spans is not None:
                spans.extend((m.start(), m.end()) for m in matches)
    return found
