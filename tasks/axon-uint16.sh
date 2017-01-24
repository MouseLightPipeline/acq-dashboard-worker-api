#!/bin/bash
project_name=$1
project_root=$2
pipeline_input_root=$3
pipeline_output_root=$4
tile_relative_path=$5
tile_name=$6
ilastik_project="$7/axon_uint16.ilp"

input_file1="$pipeline_input_root/$tile_relative_path/$tile_name-ngc.0.tif"
input_file2="$pipeline_input_root/$tile_relative_path/$tile_name-ngc.1.tif"
output_file="$pipeline_output_root/$tile_relative_path/$tile_name"
output_file+="-prob"
output_file1="$output_file.0.h5"
output_file2="$output_file.1.h5"
log_file="/groups/mousebrainmicro/mousebrainmicro/LOG/2016-10-31-DEMO-2/ilp_06062-rKwXRk9zgP.txt"

# Default location on test machines.  Most configurations should export IL_PREFIX in their launch script that also sets
# machine id, etc.
if [ -z "$IL_PREFIX" ]
then
  if [ "$(uname)" == "Darwin" ]
  then
    export IL_PREFIX=/Volumes/Spare/Projects/MouseLight/Classifier/ilastik/ilastik-1.1.8-OSX.app/Contents/ilastik-release
  else
    export IL_PREFIX=/groups/mousebrainmicro/mousebrainmicro/cluster/software/ilastik-1.1.9-Linux
  fi
fi

# Comments and execution based on iLastik's default run script.

# Do not use the user's previous LD_LIBRARY_PATH settings because they can cause conflicts.
# Start with an empty LD_LIBRARY_PATH
export LD_LIBRARY_PATH=""

# Similarly, clear PYTHONPATH
export PYTHONPATH=""

# Do not use the user's own QT_PLUGIN_PATH, which can cause conflicts with our QT build.
# This is especially important on KDE, which is uses its own version of QT and may conflict.
export QT_PLUGIN_PATH=${IL_PREFIX}/plugins

export LAZYFLOW_THREADS=10
export LAZYFLOW_TOTAL_RAM_MB=150000

${IL_PREFIX}/bin/python ${IL_PREFIX}/ilastik-meta/ilastik/ilastik.py --headless --logfile="$log_file" --cutout_subregion="[(None,None,None,0),(None,None,None,1)]" --project="$ilastik_project" --output_filename_format="$output_file1" --output_format=hdf5 "$input_file1"

${IL_PREFIX}/bin/python ${IL_PREFIX}/ilastik-meta/ilastik/ilastik.py --headless --logfile="$log_file" --cutout_subregion="[(None,None,None,0),(None,None,None,1)]" --project="$ilastik_project" --output_filename_format="$output_file2" --output_format=hdf5 "$input_file2"

if [ $? -eq 0 ]
then
  echo "Successfully executed ilastik"
  exit 0
else
  echo "ilastik failed"
  exit 1
fi

 # LAZYFLOW_THREADS=20 LAZYFLOW_TOTAL_RAM_MB=150000 /groups/mousebrainmicro/mousebrainmicro/cluster/software/ilastik-1.1.9-Linux/run_ilastik.sh
 # --headless  --cutout_subregion="[(None,None,None,0),(None,None,None,1)]" --logfile=/groups/mousebrainmicro/mousebrainmicro/LOG/2016-10-31-DEMO-2/ilp_06062-rKwXRk9zgP.txt
 # --project=/groups/mousebrainmicro/mousebrainmicro/erhan_dm11/AxonClassifier/axon_uint16.ilp --output_format="hdf5"
 # --output_filename_format=/nrs/mouselight/cluster/2016-10-31-demo-2/classifier_output/2016-11-03/00/00105/00105-prob.1.h5
 # /groups/mousebrainmicro/mousebrainmicro/from_tier2/data/2016-10-31/Tiling/2016-11-03/00/00105/00105-ngc.1.tif