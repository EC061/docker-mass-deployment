# Docker Mass Deployment System for Educational Environments

## Project Overview
This project provides a streamlined solution for mass deployment of Docker containers in educational settings. It enables instructors and system administrators to efficiently provision containerized environments for multiple students simultaneously, ensuring consistent development and testing environments across an entire class. The system is specifically designed to work with University of Georgia eLC (electronic Learning Commons) downloaded grade book CSV files.

## Features
- Batch deployment of pre-configured Docker containers for an entire class
- Customizable container templates for different course requirements
- Resource allocation management to prevent server overload
- Student access control and authentication
- Monitoring and analytics for container usage
- Easy cleanup and reset functionality between assignments

## Prerequisites
- [Docker Engine](https://docs.docker.com/engine/install/) (version 20.10.x or later)
- [NVIDIA Docker runtime](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html) (for GPU support)
- Python 3.8+ with the following packages:
  - pandas
- CSV file exported from University of Georgia eLC grade book containing these columns:
  - OrgDefinedId
  - Last Name
  - First Name
  - End-of-Line Indicator

## Installation

### 1. Clone the Repository
```bash
git clone https://github.com/EC061/docker-mass-deployment.git
cd docker-mass-deployment
```

### 2. Set Up Python Environment (Choose one option)

#### Option A: Using pip (standard)
```bash
# Create and activate a virtual environment
python -m venv venv
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt
```

#### Option B: Using uv [[Link]](https://github.com/astral-sh/uv) (faster alternative)
First, install uv if you don't have it already:
```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

Then, create and activate a virtual environment:
```bash
uv venv
source .venv/bin/activate

# Install dependencies
uv pip install -r requirements.txt
```

### 3. Build the Docker Image
```bash
docker build -t custom-ssh -f core/docker/Dockerfile .
```

## Usage
The system uses a Python script to deploy containers from a CSV roster file:

```bash
python main.py --mode MODE [OPTIONS]
```

### Command Line Options

| Option | Description | Default |
|--------|-------------|---------|
| `--mode MODE` | Deployment mode: 'group' (all users), 'single' (one user), or 'manual' (direct params) | (required) |
| `--image IMAGE` | Docker image to deploy | custom-ssh |
| `--port PORT` | Starting host port number | 50000 |
| `--user USER_ID` | Deploy container for a specific user by OrgDefinedId (for single mode) | (none) |
| `--manual-username USERNAME` | Username for manual deployment | (none) |
| `--manual-password PASSWORD` | Password for manual deployment | (none) |
| `--manual-docker-name NAME` | Docker container name for manual deployment | (none) |
| `--cpu LIMIT` | CPU limit for containers | 4 |
| `--ram LIMIT` | RAM limit for containers | 8g |
| `--storage LIMIT` | Storage limit for containers | 50g |

### Examples

Deploy containers for all users in the CSV file (group mode):
```bash
python main.py --mode group --image debian-ssh
```

Deploy a container for a specific user (single mode):
```bash
python main.py --mode single --user 811000000 --port 51000
```

Deploy a container with manual parameters (manual mode):
```bash
python main.py --mode manual --manual-username student01 --manual-password pass123 --manual-docker-name container01 --port 51000
```

Deploy with custom resource limits:
```bash
python main.py --mode group --cpu 2 --ram 4g --storage 20g
```

## Contributing
Contributions are welcome! Please feel free to submit a Pull Request.

## License
This project is licensed under the MIT License - see the LICENSE file for details.
